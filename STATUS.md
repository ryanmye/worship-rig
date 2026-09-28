# Worship Rig: status (2026-09-28, after the H-v2 Perform + Edit, the slot EQ, and hv2-edit-integrate)

One page. Details: `CONTRACT_CHANGES.md` (every change, with numbers), `reviews/` (findings), `test/README.md`.

## What works (verified on the 2-vCPU Linux container)

Latest: `node test/run-all.mjs --skip soak` after hv2-edit-integrate: **10/12 on the first pass, 1 skipped (soak)**.
The two failures are flaky tests that pass on re-run: engine `offline.masterEqGlue` and ui-core "Quick sheet: TAP"
(see Known issues 7–8; ui-core re-run 39/39). The table below is from that run where it changed. The rest, and the
soak, are from the earlier full `--soak-minutes 10` run (integration-2).

| suite | result | what it proves |
|---|---|---|
| unit | 239/239 | shared modules: music, params, automation, prng, keydetect, chords, wav |
| engine | 58/58, 0 console errors | sustain, re-strike, split, transpose, gapless song switch, wash reverb across switch/restart, drones, undamped-keys opt-in |
| instruments | 143/143 | synth/organ/voice levels, release, stealing, dispose |
| synth-extra | 153/153 | the extra synth patches and their trims |
| shell | 156 (node 130, browser 12, Electron 14) | store, controller, MIDI `_inject`, server (Range, MIME, traversal/realpath), recorder, Electron boot with 404 detection |
| ui-core | 38/39 (39/39 re-run) | H-v2 Perform view, top bar, lock rules, Quick sheet, step chips, focus/Space after Settings |
| edit-v2 | 10/10 files, 74 tests (75 with the Perform "+" test added after the run) | H-v2 Edit: shell, 8 panels on the harness, and the real app (boot at 1440/1024, Tone EQ, Perform ⇄ Edit baseline, "nothing lost") |
| settings | 26/26 (app + fixture) | Settings modal over the new Edit, and on the fallback components |
| eq | 22/22 | the keyboard Tone EQ component and its math |
| chrome-fallback | 17/17 | `serve.mjs`, start overlay, key A sounds, single-window reuse, SIGINT |
| electron-full | 28/28 | real app under Electron: 3 songs sound, 2 s recording is a valid WAV, clean quit |
| build-lint | 26/26 (re-run) | packaged asar contents (77.1 MB, 1999 samples, 23 instruments), packaged app boots with 0 errors |
| soak (10 min) | 11/11 | 8605 events, 22 song switches: voices back to 0, nodes 224 → 223, heap +0.6 MB, no NaN, 0 errors |

- **Audition** (`node tools/audition.mjs`): 62/62 clips pass (19 songs, 43 instruments), 0 warnings. 12 clips are
  in `audition/mp3/` (160 kbps) for listening: sunday-pad-piano, prayer-wash, organ-swell, upright-pad, grand-piano,
  rhodes, 80s-ballad, lofi-rhodes, dusty-piano, anthem, synthwave, dream-juno.
- **Fresh clone** (copy without `node_modules`/`dist`/renders, `npm ci`, `npm test -- --fast`): 8/8 suites pass.
  `npm start` there boots the Electron app on 127.0.0.1:8438 with 0 console errors and 0 HTTP errors (only warning:
  no MIDI device in the container). Electron 44 downloads its binary on first use; Node ≥ 22.12 is required.

## Not verified here (needs the Mac and real gear)

- **Mac build**: `npm run build:mac`, the ad-hoc codesign in `build/afterPack.js`, first launch and Gatekeeper.
  build-lint only checks the same `files` config on a Linux `dir` build.
- **Hardware**: a real MIDI keyboard, sustain pedal polarity, hot-plug and unplug mid-note, MIDI Learn footswitch.
  MIDI is only covered by injected events. Also the real audio device: latency, output selection (`setSinkId`).
- **Listening**: every level check is a robot listener. Nobody has heard the clips yet.
- **GarageBand import** against real GarageBand content (tested on synthetic `.exs` files only).
- `Start Worship Rig.command` on macOS, and the docs `openPath` fallback (round2-shell #7, macOS-only).
- Run the 5-minute "Manual check on your Mac" in `README.md` after each build.

## Known issues

1. **About 1 GB of decoded samples pinned in memory.** The soak reports `decodedMB` 1023.6 after visiting the 19
   songs (flat afterwards, so no leak). With no setlist chosen, the whole library is preloaded and pinned, and pinned
   buffers are never evicted, so the 700 MB cache cap can't hold. Risky on an 8 GB Mac with other apps open, and it
   grows with each sampled song. Needs a policy decision (pin only a real setlist, or cap pinned bytes). Details:
   `reviews/integration-findings.md`, Round 2, item 3.
2. **Two layers are buried** (round2-shell #8, confirmed by this audition): the Gospel Stab + B3 poly-stab is
   −12.6 dB under the mix even at full wheel, and the Synthwave square lead is −13.5 dB. The suggested fix is
   gain 0.5 → 0.8 and 0.6 → 0.9, then re-audition. Not changed, because it should be decided by ear.
3. Clav Funk's space shows as "Custom" (round2-shell #9, nit, deliberate).
4. build-lint once exited 5: that was `xvfb-run` failing to clean up its temp dir after a good app report. It passed
   on the re-run and 5/5 direct boots. It now prints the stderr cause if this happens again, and reaps the Xvfb
   that `xvfb-run` leaks on that path.
5. Calibration caveats: `tools/calibrate.mjs` trims decaying instruments slightly hot and doesn't know synth-extra's
   `calibWindow` (see CLAUDE.md).
6. Chrome (:8437) and the Mac app (:8438) keep separate libraries. This is by design; move songs with Export/Import.

7. **Flaky: engine `offline.masterEqGlue`** fails about 1 run in 3. Its `neverDiff` limit is 2e-6, and Chromium's
   run-to-run summing noise is about 1e-6 (2.26e-6 seen). The limit should be about 1e-5, as CLAUDE.md advises.
8. **Flaky: ui-core "Quick sheet: TAP"** fails about 1 run in 3. Four Playwright clicks 500 ms apart must land within
   120 ± 12 BPM, and click overhead sometimes stretches the intervals to about 566 ms (106 BPM). The Edit view
   adds no measurable cost there. The fix is to tap via `quickSheet.tap(now)` with fixed timestamps.
9. Edit leftovers (CONTRACT_CHANGES "## hv2-edit-integrate", "Left open"): the dead `.ed-*` rules in
   `styles-edit.css`; the step-panel fine-slider height in `styles.css`; no level meter beside the Edit slot fader.

## Next steps

1. On the Mac: `npm ci && npm run build:mac`, launch, then run the README's manual check with the real keyboard and
   pedal.
2. Listen to `audition/mp3/`, then decide #2 (stab/lead gains) by ear.
3. Decide the preload/pin policy (#1), implement it, and re-run the soak to check `decodedMB` stays under the cap.
4. Try the GarageBand importer on a real GarageBand instrument (`docs/garageband-import.md`).
5. Put the repo under git (this container copy isn't a git repository) before the next round of changes.
