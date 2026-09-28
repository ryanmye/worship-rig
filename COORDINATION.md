# COORDINATION — single source of truth for who is doing what

Writer: the CLOUD session (claude-9b) owns this file. LOCAL (Claude Code on Ryan's Mac) never edits it; it proposes
changes by appending a line to `.cloud-outbox/status.md` tagged `COORD: …`, and the cloud updates this file within
one cycle. The cloud re-drops this file into `.cloud-inbox/` whenever it changes, so local always has the current copy.

Rule: no task starts on either side unless it is listed here under that side. If you find work that isn't listed,
report it (LOCAL: `FINDINGS`/`COORD` line; CLOUD: inbox file) instead of doing it, unless it is a ≤ 10-line fix in a
file that side owns.

Updated: 2026-09-28T20:02Z by cloud

## Ownership right now (until the next update)

| Area / files | Owner | Why |
|---|---|---|
| `app/js/views/edit/**`, `components/eq-keyboard.*`, `components/{onTile,stepChip,stepPanel,headerChipRow,holdButton,quickSheet,overlay}.js`, `shared/eq-math.js`, `shared/song-diff.js`, `shared/smart-controls.js` | CLOUD | review-round-3 reviewers + fixers are editing these now |
| `app/js/engine/fx.js`, `app/js/engine/audio.js`, `app/js/shared/params.js` | CLOUD | EQ review fixer |
| `app/js/views/perform.js`, `app/js/main.js`, `app/styles.css`, `app/styles-edit.css` | CLOUD (polish agent, after the fixers) | leftovers list |
| `tools/**`, `test/integration/{soak,smoke-chrome-fallback}.mjs`, `docs/**`, `server.js`, `serve.mjs`, `main.js` (Electron main), `preload.js`, `README.md` | LOCAL | native/hardware/build fixes |
| `app/js/controller.js`, `app/js/midi.js`, `test/integration/{lib,electron-full,build-lint}.mjs`, `test/phase1/shell/electron.boot.mjs`, `test/README.md` (build-lint row) | CLOUD (C2, ~30 min) | L-3 fix + merging L-1/L-2 into the cloud tree; LOCAL: don't edit these until C2 lands |
| `reviews/local-findings.md`, `reviews/listening-notes.md`, `.cloud-outbox/status.md` | LOCAL | reporting |
| `reviews/round3-*.md`, `reviews/ux-round2.md`, `CONTRACT_CHANGES.md` | CLOUD | reporting |
| `user-samples/**` (imports), `~/Music/Worship Rig` | LOCAL | personal content, never leaves the Mac |
| everything else | frozen — report, don't edit | |

## In flight

### CLOUD
- C1 `review3` workflow (started 19:05Z): reviewers `edit` + `eq` → fixers per area → `polish` (Echo label, per-slot
  level meters + lazy analyser tap, dead `.ed-*` CSS, fine-slider height, Effects step-panel placement, text
  `dirty` binder for Song fields, small local findings if any) → `ux-critic-2` (implemented screens vs mockups).
  ETA 20:15–20:45Z. Output: reviews/round3-edit.md, round3-eq.md, ux-round2.md, ux2-shots/, CONTRACT_CHANGES
  "## round3-*", "## polish-1".
- C2 `l3-fix` DONE 19:58Z (in cloud tree, not yet dropped): L-3 real fix in controller/midi (start() no longer waits on MIDI permission; 5 s soft timeout; late attach), L-4 bounded waits + 'midi'-only grants in cloud-owned suites, and L-1/L-2 merged into the cloud tree from raw main. ETA 20:05Z.
- C3 `polish-2` (after C1): MIDI 'pending' state shown as "MIDI starting… answer the permission prompt" not a failure toast (main.js ~548, settings.js ~910); L-6 top-bar overlap (`.audio-text { flex-shrink:0 }` or min-width 8.5ch); edit-v2/integration.test.mjs grants 'midi' only; README: packaged app reads only ~/Music/Worship Rig/Samples (L-7).
- After C1 and C3: next drop to `incoming/<stamp>/` + inbox `SYNC <stamp>` (includes COORDINATION.md).

### LOCAL (as last reported, 19:51Z)
- L1 DONE: baseline full run → FINDINGS L-1..L-4. L2 DONE: SYNC_OK 20260928T185802Z (merge 246f75c), full run 12/12 after L-5. L4 DONE: build:mac OK (365 MB app, Keystation 49es connected, 19.8 ms).
- L5 running: 20-min soak on 3a69692 (port 8438 busy until ~20:15Z; drops queue behind it).
- L3 waiting on Ryan at the keyboard: hardware checklist → `HARDWARE`; listening pass → `LISTENING`.
- L6 small, when convenient: copy user-samples/{yamaha,steinway}-grand-piano to ~/Music/Worship Rig/Samples/ so the built app sees them (L-7); bound waits in test/integration/soak.mjs + smoke-chrome-fallback.mjs with lib.waitRigReady after the next drop.

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
- Electron on macOS logged `[midi] Platform dependent initialization failed` when launched from the agent shell — LOCAL to verify with Ryan: launch Worship Rig.app / `npm start` from Finder/Terminal and confirm the keyboard connects (HARDWARE line).

## Not started / backlog (unowned until listed above)
- Level meter beside Edit fader (in C1 polish), Echo label truncation (C1), unused CSS (C1).
- Metronome/click, chord/lyric display, MIDI-out, multitrack, true shimmer reverb, choir pad — v2 backlog.
- Calibration re-run after EQ/level changes (cloud, after C1 if levels changed).
- More Logic/GarageBand imports (LOCAL, on Ryan's request).
