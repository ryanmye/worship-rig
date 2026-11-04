# v1.1: what needs the Mac, and what needs Ryan

Collected from the six v1.1 workers' reports (2026-11-03). Everything below was built and tested on the cloud Linux
box. These are the parts only the Mac, real hardware or Ryan's ears can confirm. Details per item are in
CONTRACT_CHANGES `## v11-*` and `## ci-*`.

## LOCAL (Mac) checks

### Before tagging
- [ ] `node test/run-all.mjs` on the Mac (incl. shell Electron, electron-full, build-lint, soak). The Linux
      Electron boot fixture now skips hide-on-close off macOS (CI-2), so on the Mac it must still run and pass.
- [ ] CI (`test.yml`, macos-14) green on the merged tree: the CI-1 fixes were reproduced under a local simulation,
      never on the real runner.
- [x] `npm run build:mac` + build-lint: app < 480 MB; `importer-host.js` and the 8 `tools/exs/*.mjs` runtime
      modules packaged, nothing else from `tools/`.

### v11-electron (hotkeys + update check)
- [ ] Global shortcuts fire from another app with the window hidden; macOS doesn't ask for Accessibility.
- [x] (fails: L11-3, never detected on macOS) A combination held by another app (e.g. Rectangle on ⌃⌥⌘]) shows "Another app already uses this". It's not
      confirmed that `register()` returns false on macOS.
- [ ] While recording a shortcut in Settings, ⌃⌥⌘ combinations reach the page, not Mission Control or the menu.
- [ ] Nothing stays registered after Quit or after switching shortcuts off.
- [x] (status API, see findings) Packaged build: Settings › About shows the version line about 20 s after launch; Download opens the arm64 dmg;
      no request at all with `RIG_UPDATE_CHECK=0`.

### v11-touch (curves)
- [ ] "Fit to my touch" with the Keystation and with the second keyboard; Remember with both plugged in.
- [ ] An expression pedal on the Log curve; how "sustain pedal also swells the drone" sounds.

### v11-polish (themes + B)
- [x] The longer theme words in the top bar in SF Pro at 1024 (they fit in Linux fonts); Ember title metrics.
- [ ] Daylight "Auto" follows a real macOS appearance change; the Day paper EQ graph looks right.

### v11-importer
- [x] Open the built app from Finder with Homebrew ffmpeg: the list shows the real GarageBand/Logic instruments and
      no "ffmpeg isn't installed" note.
- [ ] Import Classical Grand + Yamaha Grand Piano while Perform plays: no glitches; the packs appear without a
      restart; `node tools/import-garageband.mjs --validate` passes on the output.
- [x] Stop a big import (Steinway Grand Piano 2): it stops within about 1 s and leaves no `.…importing` folder.
- [x] With ffmpeg hidden: the afconvert note shows, and `.m4a` packs play in Electron (AAC never checked).
- [x] Quit mid-import: no stray ffmpeg and no half-written pack.

### v11-scenes
- [ ] A real footswitch (momentary and press-only) learned to Next scene; the 0.5 s glide between verse and chorus
      on the PA; ⌃⌥⌘. / ⌃⌥⌘, on a real keyboard.

### v11-metronome
- [ ] "Outputs 3–4" on a real 4-output interface: at least 4 channels reported, and no dropout when switching.
- [ ] MIDI clock into a real delay or drum machine: wire jitter, Start on the downbeat.
- [ ] The click's sound and level in in-ears.

### Still open from v1
- [ ] Split-on-restart recording; MIDI Learn on the second keyboard (hardware leftovers).
- [x] (6d8d336: 10.6 → 6.1 %; re-measure after v11-memory) Low-resource drone-frozen CPU was 10.7–11.6 % against a target of about 10 %.

## Ryan's answers (2026-11-03)
- Release path: merge `claude/amazing-ptolemy-r464ae` straight into `main` when the suites are green (no PR; Ryan is
  the only one working on the repo). The push to main runs CI on macos-14.
- Version: **1.1.0**. The tag still waits for Ryan's word after the Mac checks, because it publishes a release.
- Q3: global next/previous hotkeys move through the **setlist's songs**, not the menu-bar modes.
- Q10: yes. Lower the song-switch peak, and see how far memory can come down in general (task v11-memory).
- Q18: **Panic stops the click** (metronome and count-in; the MIDI clock sends Stop).
- Q7: keyboard curves are **per MIDI device and stay with each Mac**: device-local like the chosen MIDI input, not
  exported, and not overwritten by a replace-import.
- All other questions: still open.

## Questions for Ryan

**Electron**
1. Should an available update show any hint outside Settings › About, e.g. a dot on ⚙?
2. Default shortcuts are ⌃⌥⌘ with ] [ P = − (arrow keys clash with Rectangle/Magnet). OK, and is ±2 dB the right
   master step?
3. Should next/previous step through menu-bar modes (as built) or through setlist songs?

**Touch**
4. Should Light/Heavy/Fixed shape on top of a keyboard's calibrated curve, rather than replacing it?
5. The fit puts soft playing at 30 % output. Is that the right target?
6. Pedal curve and drone swell are saved per song. Should they be global instead?
7. Keyboard curves travel with the library, so a replace-import overwrites them. Should they stay with each Mac
   instead?

**Polish**
8. Idle chord readout: keep the dimmed last chord (today's behaviour), or blank?
9. Should Classic also get "Extra · add a sound" and the end-of-set line?
10. The song-switch memory peak is still about 810 MB against the 700 MB soft cap. Do the sustain-critic R1 (a) fix
    next (wait for the new window's pins before decoding long copies)?

**Importer**
11. Limits: 40 instruments / about 2 GB per run, 120 MB per instrument, 4 parallel encoders. OK?
12. Stop deletes the half-converted instrument rather than keeping it for a resume. OK?

**Scenes**
13. Should the menu-bar popover show the scene numbers? There's no free row today.
14. While a scene plays, Edit's faders edit the song's own levels. Should opening Edit leave the scene instead?
15. Is a 0.5 s glide right, and is wrap-around right for a single footswitch?

**Metronome**
16. 6/8 and 12/8 count the dotted-quarter beat. Do your charts use eighth-note tempos?
17. Count-in, level and after-count-in are global. Should they be per song?
18. Should Panic stop the click?
19. Do you want a footswitch or hotkey for Click?
20. The click mixes in after the ceiling (the default accent is −10.5 dBFS), so it can briefly go over 0 dBFS on a
    full mix. OK?

## Added 2026-11-04 (cloud dev round 2: decisions, review fixes, memory)

### LOCAL checks
- [ ] Full `node test/run-all.mjs` on the final dev tree (`accabe7` or later). Then shell `--only electron` once
      unlocked and once with the screen locked (L11-1/L11-2 fixes).
- [ ] ⌃⌥⌘] / ⌃⌥⌘[ with the window hidden step a real setlist (held note + drone survive); first/last song is the
      end (no wrap).
- [ ] Panic with MIDI clock out into a real receiver stops on 0xFC; an audio restart with the click running sends
      Stop then Start (R-8) and the receiver re-locks.
- [ ] Drone swell under a held pedal sounds the same as before (R-1 moved it onto the drone level).
- [ ] Memory (v11-memory): Activity Monitor / `ps -o rss` for the Electron renderer: visible, after a 10-song loop,
      and in menu-bar low-resource mode, 1.0.1 vs this branch. Linux showed about 1.8 GB → 1.2–1.4 GB, and
      low-resource 1.8 GB → 0.46 GB.
- [ ] The soak's new `peakDecodedMB` column holds 700 at a 48 kHz context.
- [ ] Far jump while holding a pad: the reverb changes at the first pause (not at the switch), and the jump itself
      has no note stall.
- [ ] Reverb build times on the M2 Pro (CONTRACT_CHANGES `## v11-memory` lists the Linux numbers).

### Questions for Ryan (round 2)
21. Should the Panic tooltip ("All notes off (Esc, ⌘.)") mention the click?
22. Auto-backups are exports, so restoring one no longer brings back keyboard curves or the other per-Mac settings.
    OK?
23. Pedal + bend push-up now stop at full drone level (before: up to 4× the drone level). OK?
24. On an audio restart the MIDI clock sends Stop + Start rather than Continue. OK?
25. After a far jump made while playing, the new song's reverb comes in at the first pause. The alternatives are a
    100–400 ms note stall, or keeping every reverb built (about 400 MB). OK?
26. In setlist mode the hard cap can push a pinned setlist song out during a switch; it's re-decoded when there's
    room. Prefer this to going over the cap?
27. Low-resource mode now drops unpinned samples (Electron 1.2 GB → 0.46 GB); showing the window again re-decodes the
    songs around the current one. OK?
