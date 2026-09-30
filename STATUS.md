# Worship Rig: status (2026-09-29, after the critics' round: onboarding, security, performance → critics-fix)

One page. Details: `CONTRACT_CHANGES.md` (every change, with numbers), `reviews/` (findings), `test/README.md`,
`reviews/for-local.md` (what the Mac session is asked to do), `BACKLOG.md`.

## Test results

Latest full picture: LOCAL's Mac run at 2026-09-28 22:51Z (merge d921d4d, `run-all` incl. the 20-min soak), then the
cloud suites re-run after critics-fix on the 2-CPU Linux box. The box was shared with the theme agents (load 30–55
for most of the critics-fix runs), so several suites died on their 30 s `__rig.ready` boot bound; those are marked.

| suite | result | where / when | what it proves |
|---|---|---|---|
| unit | 276/276 | Mac 22:51Z | shared modules: music, params, automation, prng, keydetect, chords, wav, eq-math, themes, bus |
| engine | 68/69 + 1 soft warn | Mac 22:51Z | sustain, switches, drones, EQ, idle disarm (idle-cpu) |
| instruments / synth-extra | 143/143 · 153/153 | Mac 22:51Z | levels, release, stealing, dispose, patch trims |
| shell | 180/180 | Mac 22:51Z | store (incl. security S2/S3), controller, MIDI, server, recorder, Electron boot |
| ui-core | 57/61 (full run, load 20–23) | Linux, this step | Perform, top bar, lock, Quick, meters, first-run card (+7 critics-fix tests) |
| edit-v2 | blocked (load 45–78) | Linux, this step | Edit shell + 8 panels + real app (+3 critics-fix tests) |
| settings | 25/33, 27/33 (load 44–61) | Linux, this step | Settings modal, Menu bar section (+1 critics-fix test) |
| eq | not run | — | keyboard Tone EQ + L-21 note cells |
| mini / themes | not run here | — | menu-bar popover over BroadcastChannel; every theme boots and switches (theme agents) |
| chrome-fallback / electron-full / build-lint | 15/15 · 28/28 · 23/23 | Mac 22:51Z | serve.mjs, the real Electron app, the packaged asar (379 MB app, < 480 MB guard) |
| soak (20 min) | 12/12 | Mac 22:51Z | 38 switches, 16964 events, voices → 0, nodes flat, heap +0.64 MB, max pinned 568.9 / 600 MB, decoded ≤ cap with `retiring === 0` |

Notes on this step's runs (the theme agents kept the 2-CPU box at load 20–100 for two hours):
- ui-core 57/61: the 4 failures were "next / prev" and "Quick TAP" (known load flakes, item 6 below), the polish-1
  meter test (now allows ~30 reads/s and a sleeping silent strip) and the no-autoplay test's new "no Sound OK" check
  (fixed by re-rendering the lamp when the overlay shows). All 7 critics-fix tests pass, alone and in the full run;
  the two fixes were checked with direct scripts (their suite re-run died on page.goto / boot bounds at load 54).
- edit-v2: every file failed its 30 s mount bound in 3 attempts. The three changed behaviours (+ Setlist / + New song,
  the pencil, the hidden-Edit notes catch-up) were checked in the real app with a direct script: all as expected.
- settings: the new critics-fix test passed in both modes in both runs; every other test passed in at least one run
  except boot (30 s ready bound), "latency … sound after restart" and MIDI Learn (app), which failed in both.
- eq: no eq file changed; not run. A load-gated runner (`scratchpad/cf-gentle.sh`, log `cf-gentle.txt`) re-runs
  ui-core, edit-v2, settings and eq one at a time when the 1-min load drops below 14.

Hardware (Mac, Ryan at a Keystation 49es, 02:39Z): auto-select, pedal (with a wording note, now in Settings),
latency (dock 20 ms, Bluetooth 176 ms), wheels, hot-unplug, sleep/wake, recording, lock tiers all passed. MIDI Learn
(no spare CC control), split-on-restart recording, songs/drone/pads/My Samples and the Chrome column are still open
(`reviews/hardware-checklist.md`).

## What changed today (2026-09-28 → 29)

- **H-v2 Perform + Edit** finished and integrated (hv2-*), then polished (polish-1, polish-2A/2B) and reviewed twice
  (round3, round4: controller / perform / edit-lib, each with a fixer).
- **Memory policy** (l8, round4-controller C2): a setlist is pinned only when its exact size fits `PIN_BUDGET_MB`;
  otherwise a large-set window. The ~1 GB "everything pinned" issue is gone (soak max pinned 568.9 MB).
- **Menu-bar mode** (C7 menubar-A/B + LOCAL menubar-electron): `shared/bus.js`, `mini.html` popover, low-resource mode,
  tray, hide-on-close.
- **Themes** (themes-setup): 8 selectable themes (default Sanctuary), Settings › Appearance, Quick › Theme.
- **Idle CPU** (idle-cpu): idle instruments are disconnected from their strips (Sunday Pad drone-off 31 → 16 % here).
- **Security** (security): imports bounded (depth 64, 2 M chars), exports drop device-local settings.
- **Critics-fix** (this step): hold-to-unlock works at any hold length (O1); "Loading…" no longer covers the title;
  a one-time **Start here** card and computer-key letters on the piano; plain copy in Quick / Settings / toasts;
  "Saving…" after REC; a tap on locked Edit/⚙ says why; no "Sound OK" while audio waits for a click; meters capped at
  ~30 fps and asleep when silent; the wheel path writes only what changed (main-thread task −12 to −39 %, layout
  −23 to −52 % in the three profiled songs); Edit stops tracking notes while hidden.

## Open items

1. **Mac verification after the next drop** (for-local.md): L-23 / long-hold unlock, pedal wording, `IDLE_CPU_MAC3`,
   `HIDDEN_RAF`, `PROFILE_MAC`, `SOAK_RSS`, `C2_MAC`, `M1_MAC`, `L20_MAC`, `L21_MAC`, `EXPORT_NONASCII`.
2. **S1 (major, needs Ryan):** six Apple `.exs` files are public in `ryanmye/worship-rig` (`tools/exs/fixtures/real`).
   Remove + purge history or make the repo private. S4–S8 hardening is LOCAL's.
3. **README (LOCAL):** volunteer-first path, "first five minutes", vocabulary table (onboarding R1–R6 + critics-fix).
4. **Engine (frozen, report only):** performance #1 (decode copies + warm-up throttling while playing), #4 (convolver
   builds on the main thread, macro.wash songs), #5 (note-on fan-out); renderer RSS growth over 3 laps (#6, unverified).
5. **Needs an ear:** buried Gospel Stab + B3 stab (−12.6 dB) and Synthwave lead (−13.5 dB); named Space/Echo for the
   first 11 factory songs (onboarding O4); the listening pass on `audition/mp3/` and the 28 My Samples packs.
6. **Flaky on a loaded box:** ui-core "next / prev" (the jump back to song 1 after the 19-song walk is a cold
   large-set load: ≈ 58 s at load 18) and "Quick TAP"; boot bounds (30 s `__rig.ready`) whenever load > ~20.
7. Not built: per-file key picker for unrecognised pad files (O10), Trusted Types (S11), level-meter hold via
   `transform` (themes paint the hold), metronome / chord display / MIDI-out (v2 backlog).
