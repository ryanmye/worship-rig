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
- [ ] `npm run build:mac` + build-lint: app < 480 MB; `importer-host.js` and the 8 `tools/exs/*.mjs` runtime
      modules packaged, nothing else from `tools/`.

### v11-electron (hotkeys + update check)
- [ ] Global shortcuts fire from another app with the window hidden; macOS doesn't ask for Accessibility.
- [ ] A combination held by another app (e.g. Rectangle on ⌃⌥⌘]) shows "Another app already uses this". It's not
      confirmed that `register()` returns false on macOS.
- [ ] While recording a shortcut in Settings, ⌃⌥⌘ combinations reach the page, not Mission Control or the menu.
- [ ] Nothing stays registered after Quit or after switching shortcuts off.
- [ ] Packaged build: Settings › About shows the version line about 20 s after launch; Download opens the arm64 dmg;
      no request at all with `RIG_UPDATE_CHECK=0`.

### v11-touch (curves)
- [ ] "Fit to my touch" with the Keystation and with the second keyboard; Remember with both plugged in.
- [ ] An expression pedal on the Log curve; how "sustain pedal also swells the drone" sounds.

### v11-polish (themes + B)
- [ ] The longer theme words in the top bar in SF Pro at 1024 (they fit in Linux fonts); Ember title metrics.
- [ ] Daylight "Auto" follows a real macOS appearance change; the Day paper EQ graph looks right.

### v11-importer
- [ ] Open the built app from Finder with Homebrew ffmpeg: the list shows the real GarageBand/Logic instruments and
      no "ffmpeg isn't installed" note.
- [ ] Import Classical Grand + Yamaha Grand Piano while Perform plays: no glitches; the packs appear without a
      restart; `node tools/import-garageband.mjs --validate` passes on the output.
- [ ] Stop a big import (Steinway Grand Piano 2): it stops within about 1 s and leaves no `.…importing` folder.
- [ ] With ffmpeg hidden: the afconvert note shows, and `.m4a` packs play in Electron (AAC never checked).
- [ ] Quit mid-import: no stray ffmpeg and no half-written pack.

### v11-scenes
- [ ] A real footswitch (momentary and press-only) learned to Next scene; the 0.5 s glide between verse and chorus
      on the PA; ⌃⌥⌘. / ⌃⌥⌘, on a real keyboard.

### v11-metronome
- [ ] "Outputs 3–4" on a real 4-output interface: at least 4 channels reported, and no dropout when switching.
- [ ] MIDI clock into a real delay or drum machine: wire jitter, Start on the downbeat.
- [ ] The click's sound and level in in-ears.

### Still open from v1
- [ ] Split-on-restart recording; MIDI Learn on the second keyboard (hardware leftovers).
- [ ] Low-resource drone-frozen CPU was 10.7–11.6 % against a target of about 10 %.

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
