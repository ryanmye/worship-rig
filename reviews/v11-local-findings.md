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
