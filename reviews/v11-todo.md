# v1.1: what's left (2026-11-04)

The one page to read. Details: `reviews/v11-mac-checklist.md` (every Mac check, questions 1–27),
`reviews/v11-local-findings.md` (Mac results), `reviews/v11-review.md` (review R-1..R-8), CONTRACT_CHANGES
`## v11-*` / `## ci-*`.

## Where it stands
- **Development is done.** Everything is on `claude/amazing-ptolemy-r464ae` (`38a997d` or later): the 1.1 scope, Ryan's
  decisions, review fixes R-1..R-8, memory (switch peak ≤ 700 MB, renderer −450–600 MB), reverb builds only in real
  pauses, shortcut press-to-test, and the CI / Mac test fixes ci-2..ci-4 and L11-1..L11-6.
- **Cloud full run on `d39f7d5`:** 14/15. The one failure, engine `fxIdleSleep`, passed 2/2 alone and is fixed in
  ci-4. Soak 12/12, peak 700.0 MB of 700.
- **Mac full run on `d8970ef`:** 13/15 (L11-4..L11-6, all fixed since). Packaged-app checks all pass. Low-resource
  CPU is now 6.1 % (the v1 target was about 10 %).
- **CI (macos-14):** green on `ef3d58a`. Since then every red run was runner timing (ci-3, ci-4, ci-5 fixed the
  causes). Run 41 on `38a997d` was 11/12; the last ui-core test (strip meters, ci-5) is fixed in this push and passes
  76/76 here, but has **not been through CI yet**. The first push to `main` (task 03) is that check.

## 1. LOCAL session (testing): do in this order
1. `git pull` (`38a997d` or later).
2. Full `node test/run-all.mjs` on the Mac, then shell `--only electron` once unlocked and once locked (L11-2/L11-4).
   Write anything new as `## L11-7…` in `reviews/v11-local-findings.md`, push, and stop for the cloud to fix it.
3. The Mac-only checks still open in `v11-mac-checklist.md`, then the new ones:
   - press-to-test steps 1–5 (in CONTRACT_CHANGES `## v11-hotkey-test`): Test → "Works" without running the
     action; a clash → "Nothing came through"; that also answers which app gets the press;
   - memory in Activity Monitor: 1.0.1 vs this branch, visible / after a loop / low-resource;
   - the soak's `peakDecodedMB` ≤ 700 at 48 kHz; the dual-mono sets show about half the decoded MB.
4. Ryan's hardware batch (one sitting, see below).
5. When 2–4 are green: **task 03 in the handoff**:
   1. Bump the version to 1.1.0.
   2. Merge into `main` (no PR) and push. CI runs.
   3. Trim "Not yet checked on real hardware" in `docs/release-notes-1.1.0.md`.
   4. **Ask Ryan, then push the tag `v1.1.0`.**

   Push the tag right after `main`: the site redeploys on every push to main and would announce 1.1 while the
   download buttons still give 1.0.1. Take the 4 site screenshots (the `SHOT` placeholders in `docs/site/index.html`).

## 2. Ryan's hardware batch (with LOCAL, about 30–45 min)
- **Keyboards:** "Fit to my touch" on the Keystation and on the second keyboard; Remember with both plugged in; MIDI
  Learn on the second keyboard (v1 leftover).
- **Pedals:** expression pedal on the Log curve; the drone swell under a held pedal (sounds the same as 1.0?); a
  footswitch learned to Next scene (momentary + press-only).
- **Shortcuts:** global shortcuts from another app with the window hidden: ⌃⌥⌘] / ⌃⌥⌘[ step the setlist; Test
  with Rectangle or Raycast holding the same keys.
- **Click:** sound and level in in-ears; outputs 3–4 on a 4-output interface; MIDI clock into a drum machine or
  delay (Start on the downbeat, Panic → Stop, audio restart → Stop + Start).
- **By ear:** scenes' 0.5 s glide between verse and chorus on the PA; a far jump while holding a pad (reverb
  changes after a 2 s pause, no hiccup).
- **Recording:** split-on-restart (v1 leftover).

## 3. Decisions for Ryan (none blocks the tag; the defaults ship as built)
Recommended answers in brackets. The full wording is in `v11-mac-checklist.md`.
- **Live feel**
  - Q15: 0.5 s scene glide and wrap-around [keep].
  - Q25: reverb at the first 2 s pause after a far jump [keep].
  - New: should the wash wheel's room size also wait for a pause, or follow the wheel while playing [follow].
  - New: song-switch main-thread work (170–270 ms on the Linux box; less on the M2 Pro) is now the main cause of a
    late note at a switch. Do it in 1.1.x or 1.2 [1.2, after measuring on the Mac].
- **Memory**
  - Q26: hard cap during a switch [keep].
  - Q27: low-resource trim [keep].
- **Click**
  - Q16: 6/8 counts the dotted quarter [keep].
  - Q17: count-in, level and after-count-in are global [keep for 1.1].
  - Q19: no footswitch or hotkey for Click yet [add in 1.1.x if wanted].
  - Q20: the click mixes after the ceiling [keep; the default accent is −10.5 dBFS].
- **Touch**
  - Q4: Light/Heavy/Fixed replace the keyboard's curve [keep].
  - Q5: soft playing fits to 30 % [keep until the hardware batch].
  - Q6: pedal curve and swell saved per song [keep].
- **Electron**
  - Q1: update hint only in Settings › About [keep].
  - Q2: default keys ⌃⌥⌘ ] [ P = − and ±2 dB [keep].
  - Q21: should the Panic tooltip mention the click [yes, trivial].
  - Q22: a restored auto-backup keeps this Mac's own settings [keep].
- **Other**
  - Q8: idle chord readout dims the last chord [keep].
  - Q9: Classic doesn't get the warm themes' extra lines [keep].
  - Q11/Q12: importer limits; Stop deletes the half-done instrument [keep].
  - Q13: no scene numbers in the popover yet [later].
  - Q14: Edit's faders edit the song's own levels while a scene plays [keep].
  - Q23: pedal + bend stop at full drone level [keep].
  - Q24: clock Stop + Start on an audio restart [keep].
  - Press-to-test: the warm themes have no wording of their own for its 4 new strings yet [add later].
  - S1: send the GitHub Support purge request (`reviews/s1-support-request.md`) [your call].

## 4. After 1.1 (in BACKLOG.md)
- iPad / iPhone app (Ryan 2026-11-04). The platform decision (Electron now; WebKit shell vs native Swift engine
  later) and the GPL / App Store licensing question are written up there.
- Song-switch note latency (performance #1/#4/#5); the smaller-neighbour-window and cap trade-offs from v11-memory.
- The rest of section A: EQ simple mode, chord charts, stage display, Planning Center, shimmer/choir, daily hook,
  disk streaming.
