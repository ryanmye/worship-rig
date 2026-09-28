# COORDINATION — single source of truth for who is doing what

Writer: the CLOUD session (claude-9b) owns this file. LOCAL (Claude Code on Ryan's Mac) never edits it; it proposes
changes by appending a line to `.cloud-outbox/status.md` tagged `COORD: …`, and the cloud updates this file within
one cycle. The cloud re-drops this file into `.cloud-inbox/` whenever it changes, so local always has the current copy.

Rule: no task starts on either side unless it is listed here under that side. If you find work that isn't listed,
report it (LOCAL: `FINDINGS`/`COORD` line; CLOUD: inbox file) instead of doing it, unless it is a ≤ 10-line fix in a
file that side owns.

Updated: 2026-09-28T22:20Z by cloud (Ryan away; both sides autonomous)

## Ownership right now (until the next update)

| Area / files | Owner | Why |
|---|---|---|
| `app/js/controller.js`, `midi.js`, `store.js`, `views/perform.js`, `main.js` (renderer), `styles.css`, `views/components/*` (not eq-keyboard), `views/edit/{lib,shell}.js`, `panels/{song,song-header,slot}.js`, and their suites | CLOUD (C6 review-4 reviewers → fixers) | |
| other `app/js/**`, `app/styles*.css`, `app/index.html` | CLOUD (C6 critics-fix, later in the batch) | onboarding/security/perf fixes |
| `tools/**`, `test/integration/**`, `docs/**` (except docs/menubar-mode.md = cloud), `server.js`, `serve.mjs`, `main.js` (Electron main), `preload.js`, `README.md`, `dist/`, `user-samples/**`, `~/Music/Worship Rig` | LOCAL | work list + menu-bar Electron side |
| `app/js/shared/bus.js`, `app/mini.html`, `app/mini.css`, `app/js/views/mini.js`, `test/phase2/mini/**`, plus the menu-bar additions in controller.js / engine/audio.js / store.js / views/settings.js / main.js (renderer) | CLOUD (C7) | menu-bar cloud side |
| `reviews/local-*.md`, `reviews/listening-notes.md`, `.cloud-outbox/status.md` | LOCAL | reporting |
| `reviews/round4-*.md`, `onboarding.md`, `security.md`, `performance.md`, `for-local.md`, `CONTRACT_CHANGES.md`, `STATUS.md` | CLOUD | reporting |
| `app/js/engine/**`, `shared/params.js`, `components/eq-keyboard.*`, other edit panels | frozen (report only) | |

## In flight

### CLOUD
- C1–C5 DONE. DROP 20260928T215342Z sent 21:54Z (C3 + C5; SYNC in inbox).
- C7 `menubar` (started 22:20Z, 2 agents): A = shared/bus.js + controller modes/lowResource/publish + engine low-resource hooks + store settings; B = app/mini.html + views/mini.js + Settings 'Menu bar' section + renderer lowResource reactions + Playwright tests over BroadcastChannel. Contract: docs/menubar-mode.md. Also delivered to LOCAL's inbox.
- C6 `review4` (started 21:58Z, ETA ~00:00Z): reviewers controller / perform / edit-lib → fixers per area → critics (onboarding first-run walk, security & privacy, performance profile) → critics-fix (S items + clear M bugs, STATUS.md refresh). Then drop.

### LOCAL (work list sent 21:55Z, inbox 20260928T215511Z; menu-bar task added 22:20Z)
- L14 MENU-BAR (Electron side of docs/menubar-mode.md): Tray + menu from bus state, popover BrowserWindow loading app/mini.html, hide-on-close, dock hide, login item, preload bus relay methods, tray self-test → MENUBAR_LOCAL_OK. Cloud builds bus.js/controller/engine/mini UI/Settings in parallel (C7); integrate on the next drop. Test the popover on the Mac with the CLOUD's mini.html when it lands (until then a placeholder page is fine).
- L8 SYNC 215342Z → fast → full run incl. 20-min soak → FINDINGS.
- L9 PACKS: rebuild .app; copy the two Logic pianos to ~/Music/Worship Rig/Samples → PACKS_OK.
- L10 IMPORTS: Classical Grand, Rise Above Piano, Record Collection Grand, Small Amped Acoustic Piano, GarageBand Grand Piano, Keyboard Collection Wurli/Clav/Vibe/Piano → IMPORTS.
- L11 PERF numbers on the built app (idle + 20 s loop, three songs) → PERF.
- L12 MAC-REVIEW agent over main.js/preload/server/serve/launcher/afterPack for macOS behaviours → MAC_REVIEW.
- L13 README "Running on your Mac" → README_OK.
- L3 hardware pass + listening — waits for Ryan.

## Done today (for context; don't redo)
- Mac resync v2/v3, Logic pianos converted (Yamaha, Steinway) into user-samples/ — LOCAL side by cloud agent, earlier.
- H-v2 Perform, Edit (7 panels + shell), WING EQ engine + component, integration, settings suite split — CLOUD.
- Git baseline + `tools/sync-from-cloud.sh` + public repo + relay — LOCAL.

## Open findings / who has them
- L-1 (ELECTRON_RUN_AS_NODE inherited by Electron launchers) — LOCAL fixed db41087; CLOUD merging (C2).
- L-2 (build-lint hard-coded to Linux) — LOCAL fixed 7e2439d; CLOUD merging (C2).
- L-3 (controller.start() awaits MIDI permission forever) — CLOUD (C2).
- L-4 (unbounded waits on __rig.ready) — CLOUD for edit-v2/settings/eq (C2); LOCAL for test/integration/soak.mjs + smoke-chrome-fallback.mjs (bound to 30 s, throw with controller.status.midi).
- L-5 (backup filename race in main.js) — LOCAL fixed 3a69692.
- L-6 (top-bar 'Sound OK' overlaps latency at 1440) — CLOUD (C3).
- L-7 (packaged app ignores repo user-samples; by design) — LOCAL copies packs to ~/Music; CLOUD documents (C3).
- MIDI 'pending' shown as failure toast — CLOUD (C3).
- L-8 — CLOUD fixed (C4), LOCAL verified (L8_VERIFIED). L-9 — CLOUD fixed (C5; was a test bug + 2 binder bugs). L-10 — soft-cap rule, LOCAL implemented the check (L10_RESOLVED); CLOUD documents in docs/architecture (C6 critics-fix).
- Electron on macOS logged `[midi] Platform dependent initialization failed` when launched from the agent shell — LOCAL to verify with Ryan: launch Worship Rig.app / `npm start` from Finder/Terminal and confirm the keyboard connects (HARDWARE line).

## Not started / backlog (unowned until listed above)
- Level meter beside Edit fader (in C1 polish), Echo label truncation (C1), unused CSS (C1).
- Metronome/click, chord/lyric display, MIDI-out, multitrack, true shimmer reverb, choir pad — v2 backlog.
- Calibration re-run after EQ/level changes (cloud, after C1 if levels changed).
- More Logic/GarageBand imports (LOCAL, on Ryan's request).
