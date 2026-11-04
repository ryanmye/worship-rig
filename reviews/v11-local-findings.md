# v1.1 local (Mac) findings

Written by the local Mac session while testing `claude/amazing-ptolemy-r464ae`. One `## L11-n` section per finding.
The cloud owns all code changes; this file and the checklist ticks are the only local edits.

Machine: Apple M2 Pro, macOS 26.4, Node 25.2, Electron from `npm ci`. Suite logs live in the ignored `test/logs/`
on the Mac; the relevant output is quoted below.

## Runs

| Tree | What | Result |
|---|---|---|
| ef3d58a | `npm run build:mac` | built; `Worship Rig.app` 366 MB (budget < 480 MB) |
| ef3d58a | packaged `tools/` | `importer-host.js` + the 8 `tools/exs/*.mjs` runtime modules, nothing else from `tools/` |
| ef3d58a | first full run (stopped by a machine restart after 6 suites) | unit, engine 91/92 (1 soft warning, 0 failures), instruments 143/143, synth-extra 153/153, ui-core pass; shell 1 failure (L11-1) |
| ef3d58a | **full `node test/run-all.mjs`, 2026-11-03 ~19:00–19:37 EST, screen unlocked** | **15/15 suites PASS in 36m52s** (table below) |
| ef3d58a | shell `--only electron` ×5, 19:38–19:45 EST, **screen locked** | 5/5 exit 1, same test each time (L11-2); L-30 passed all 5 |
| 070eb50 (v11-decisions A/B/C + R-3/R-4 in) | `run-all --skip soak` | 13/14 pass in 15m49s; shell 265/266, the one failure is L11-2 (screen locked during the run); unit 385, ui-core 82, settings 57/57 |
| 070eb50 | shell `--only electron`, screen unlocked | 22/22 pass |

Full run, ef3d58a:

| suite | result | detail |
|---|---|---|
| unit | PASS | 382 pass |
| engine | PASS | 91/92, 1 soft warning, 0 failures, 0 console errors |
| instruments | PASS | 143/143 |
| synth-extra | PASS | 153/153 |
| shell | PASS | 259 pass (incl. Electron boot; L-30 passed this time) |
| ui-core | PASS | 81 pass |
| edit-v2 | PASS | 105 pass |
| settings | PASS | 57/57 (modes app, fixture, mac) |
| eq | PASS | 28/28, 3 notes |
| mini | PASS | 14/14 |
| themes | PASS | 57/57 (coverage json churn discarded) |
| chrome-fallback | PASS | 15/15, 1 skipped |
| electron-full | PASS | 28/28 |
| build-lint | PASS | 43/43, 1 skipped |
| soak | PASS | 12/12 in 20m45s |

Soak numbers: 39 switches (15 lofi), 15 panics, 17852 events, 0 NaN. **Max decoded 812 MB against the 700 MB cap**
(pinned 442 MB at that moment; passes only through the soft +25 % exemption), max pinned 454.3 MB on
factory:lofi-rhodes, end state 639.5 MB decoded. Heap 12.33 → 14.34 MB after GC. This is the task-01 baseline on
real hardware: the switch peak matches the cloud's ~810 MB.

## L11-1 shell Electron: L-30 tray-hidden test sees extra window events on the Mac

**Status:** fixed by the cloud (2026-11-04): the self-test's `trayEvents` keeps only `tray*` ids; window events stay
asserted in the L14 test. Please re-run on the Mac. (Was: flaky, low priority. Failed once (first run, 18:5x EST),
passed in the full run and in 5 more Electron runs.)

`test/phase1/shell/electron.boot.mjs:312`, "L-30 tray hidden: trayHidden once (debounced, past the 3 s re-check),
popover fallback, trayShown, Rig menu". The other 21 Electron boot tests passed.

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ actual - expected
  [
    'trayHidden',
+   'windowHidden',
+   'windowShown',
    'trayShown'
  ]
    at TestContext.<anonymous> (test/phase1/shell/electron.boot.mjs:322:10)
```

The bus delivered a `windowHidden` / `windowShown` pair between `trayHidden` and `trayShown`. The test's expected
list has no window events. Candidates: the popover fallback now hides/shows the main window on macOS (the CI-2 change
made the Linux fixture skip hide-on-close, so this path only runs on a Mac), or the test should filter to tray ids.

## L11-2 shell Electron: the ⌘H guard asserts while the screen is locked

**Status:** fixed by the cloud (2026-11-04): the self-test records `screenLocked`
(`powerMonitor.getSystemIdleState(1) === 'locked'`) and the ⌘H events are asserted only when unlocked. Please
re-run locked and unlocked. (Was: open; reproduces 5/5 with the screen locked, passes unlocked.)

`test/phase1/shell/electron.boot.mjs:295`, inside "menu-bar mode (L14): tray, menu from the bus state, IPC relay both
ways, popover, hide-on-close":

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
+ actual - expected
+ []
- [
-   false,
-   true
- ]
    at TestContext.<anonymous> (test/phase1/shell/electron.boot.mjs:295:42)
```

`m.appHideObserved` is true but `m.windowVisibleAppHide` is empty: on a locked Mac `app.hide()` reports as done while
the window never sends `rig:window-visible`. The guard's comment already says the hide "needs an unlocked screen /
window server"; the guard should also skip (with the `#` note) when no visibility event arrives, the way the
minimise guard does. Repro: lock the screen (⌃⌘Q), then `node test/phase1/shell/run.mjs --only electron`.
L11-1 may be the same family (window events depending on the display state), so treat both together.

## Packaged-app checks on 6d8d336 (before v11-memory), 2026-11-03 ~20:00–20:30 EST

Built with `npm run build:mac` (366 MB). Every launch used a throwaway `RIG_USER_DATA`, `RIG_PORT=8450` and, for the
importer, a throwaway `RIG_USER_SAMPLES`; Ryan's library and `~/Music/Worship Rig` were not touched. The app was
driven over `--remote-debugging-port` with Playwright `connectOverCDP` (scripts in the ignored `test/logs/pkg-*.mjs`).

| check | result |
|---|---|
| Update check against real GitHub (1.0.1 build) | `state: latest`, `latest: 1.0.1`; cache in `rig-shell.json` has the v1.0.1 arm64 dmg URL |
| Update check, fake feed announcing v1.1.0 | `state: update`, `latest: 1.1.0`, `downloadUrl` = `…/releases/download/v1.1.0/Worship-Rig-arm64.dmg`, `asset` arm64 |
| `RIG_UPDATE_CHECK=0` | `supported: false`, `state: unsupported`, no `rig-shell.json` written (no request) |
| Importer scan with launchd's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`, as from Finder) | encoder `ffmpeg` (found in `/opt/homebrew/bin`), mp3; 102 instruments; 0 parse errors; scan 300 ms |
| Import Classical Grand + Yamaha Grand Piano | done in 13 s, 52 + 252 files, 0 missing, 10 + 36 MB; `--validate` OK on both (L/R anti-correlation notes on C5/C7 come from the Apple sources) |
| Stop Steinway Grand Piano 2 after 3 s (4 ffmpeg running) | `cancelled` in **57 ms**; no ffmpeg left; output folder empty (no `.…importing`) |
| Quit (SIGTERM) mid-import, same instrument | no ffmpeg left; output folder empty |
| ffmpeg hidden (`FFMPEG=/nonexistent/ffmpeg`) | encoder `afconvert`, m4a; Classical Grand in 7 s, 52 `.m4a`; two decoded in Electron via `/user-samples/…`: 11 s, 2 ch, 44.1 kHz, peaks 0.34 / 0.55 |
| All 8 themes at 1024×700 in the packaged app (real SF Pro + bundled faces) | no horizontal scroll (`scrollWidth` 1024), no clipped leaf text in the top bar; `.song-name` 40 px box on 40 px line in every theme incl. Ember. Screenshots: `test/logs/shots/theme-1024-*.png` on the Mac |
| Low-resource CPU, Sunday Pad + Piano (synth drone), visible | renderer **46.1 %** off → **10.6 %** first 20 s on → **6.1 %** next 20 s; GPU 5.9 % → 0.0 % (was 10.7–11.6 % in 1.0.1) |

Not checked here (needs a real key press, ears or hardware): shortcuts firing from another app, shortcut recording
in Settings, "while Perform plays: no glitches", Daylight Auto on a real appearance change.

## L11-3 Global shortcuts: "taken" never shows on macOS; registration succeeds even when another app holds the combination

**Status:** fixed by the cloud (2026-11-04), wording only: Settings › Menu bar now says on macOS "macOS doesn’t
tell apps when another app uses the same shortcut. If one does nothing, pick another." README, release notes and
docs/menubar-mode.md no longer promise a warning. The `taken` state stays for a register() that really fails. Still
open for Ryan's batch: which app receives the press when both hold it. (Was: open; confirms the checklist's doubt.)

A helper Electron app (`test/logs/hk/`) registered `Control+Alt+Command+]` first (`register()` → true) and kept it.
Then the packaged Worship Rig was switched on with the defaults:

```
HELPER Control+Alt+Command+] true
on {"on":true,...,"keys":{"nextSong":{"accelerator":"Control+Alt+Command+]","state":"ok"}, ... all "ok"}}
```

So on macOS `globalShortcut.register()` returns true for a combination another process already holds (Carbon
`RegisterEventHotKey` allows duplicates across apps), and Settings will never show "Another app already uses this".
Which app receives the press when both hold it is not known yet (needs a real key press, Ryan's batch).
For the same reason, the "nothing stays registered after Off / Quit" check can't be proved this way: the helper's
`register()` returned true for all 7 defaults after Off and after Quit, but it would have returned true anyway.

Suggestion for the cloud: drop the macOS promise of "taken" in the Settings copy, or describe it as "macOS can't tell
us if another app uses this; if a shortcut does nothing, pick another". No code path is broken; the state just can't
be detected.

### L11-3 follow-up: Ryan's decision (2026-11-03): keep it customizable, and let the user find conflicts themselves

Customizing already works (Settings › Menu bar › Global shortcuts: click a key to record, Delete clears, "Use the
standard keys" resets, duplicates inside Worship Rig are refused). Ryan: "make it so user can customize". What the
cloud should add, since macOS won't report a conflict:

1. **A "press it to test" check.** After recording a combination (and on a "Test" link next to each row), show
   "Press ⌃⌥⌘] in any app…" and, when the global shortcut fires, "Works". If nothing arrives within ~5 s:
   "Nothing came through. Another app may use this. Pick another." That replaces the never-shown `taken` state on
   macOS with something the user can see.
2. **Settings copy:** say plainly that macOS can't tell us when another app (Rectangle, Magnet, Raycast…) uses a
   combination, so test each one once.
3. Keep `taken` for platforms where `register()` does return false; on macOS don't rely on it.
4. Tests: a unit test for the test-mode state machine (fired → "Works", timeout → hint) and the settings "mac" mode.
   The real cross-app press stays in Ryan's hardware batch.
