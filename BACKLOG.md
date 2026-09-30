# BACKLOG — ideas and deferred work (kept so nothing is lost)

Owner: cloud session writes it; either side may propose lines via `.cloud-outbox/status.md` (`BACKLOG: …`) or an
inbox file. Items move to COORDINATION.md "In flight" when scheduled. Last updated 2026-09-30 (themes-final).

Legend: **S/M/L** effort · **who** = which side is the natural owner (cloud = implementation, local = Mac/hardware).


## v1 release gate (Ryan, 2026-09-30: "after we are done with our backlog we should be good to release v1")
Proposed reading: v1 ships when the items below are done; everything else in sections A–C is v1.1+ unless Ryan pulls
it in. Cloud proposes, Ryan decides.
**Must (v1):**
- [ ] Next cloud drop merged on the Mac: review-4 fixes, engine idle-CPU, themes (8, Sanctuary default, T1 font fix),
      popover theming, hardware fixes (L-23/L-25, two-state pedal test, Bluetooth hint), C9 UI idle items, L-24 audit.
- [ ] Low-resource part 2 (drone freeze + audio sleep) merged and measured on the Mac (hidden drone-on ≤ ~10, asleep ≈ 0).
- [ ] Full suites green on the Mac incl. Electron, build-lint, 20-min soak; CI green on main (macos-14).
- [x] Listening pass — Ryan did it offline 2026-09-30 and is happy with the sounds; no calibration round needed.
- [ ] Hardware leftovers with Ryan: split-on-restart recording; MIDI Learn on the second keyboard.
- [ ] Release pipeline: v1.0.0 tag APPROVED by Ryan (2026-09-30, after the drop + icon); Release with arm64 + x64 dmg/zip (dry run passes); README "Running on your Mac"
      current; Starter library JSON exported and attached.
- [ ] Site: real content + Mac screenshots (spec sent 2026-09-30), download buttons live once the Release exists.
- [ ] Security: S1–S8 done; GitHub Support purge request — Ryan's call (not blocking).
- [ ] App size < 500 MB per arch (366 / 372 MB today).
- [ ] App icon: LOCAL running a proposer/critic loop (brief sent 2026-09-30); Ryan picks from design/icon/options.png.
- [ ] First-run: Start-here card + key letters (done in review-4) verified on the Mac by a fresh library.
- [ ] Sustain editable per slot (Ryan 2026-09-30: grand piano fades too early under a held pedal — the sampler's 10/16 s
      sample cap; make the cap per instrument, add Release (pedal up) + Pedal hold (pedal down) to slot Advanced). Cloud
      workflow `sustain`, runs after themes-final, before the drop.
**Deferred to v1.1 (not gating) — Ryan's rule: v1 stays simple; anything that adds a new screen, mode, setting or concept waits:** everything else in A (menu-bar hotkeys, daily hook, H-sheet Edit, EQ simple mode,
metronome, chord charts, MIDI-out, multitrack, shimmer/choir, Planning Center, in-app importer, disk streaming,
auto-updater, pedal curves, scenes, stage display, practice mode, Windows/Linux), the low-resource part 3 items, and
the note-latency-after-switch engine work from reviews/performance.md unless the listening pass makes it audible.

## A. Features Ryan asked for or floated, not yet built — ALL v1.1+ (Ryan 2026-09-30: "don't make the app too complex"; nothing in A gates v1)
- Menu-bar mode v1.1: global hotkeys (`globalShortcut`) for next/prev mode, panic, master ±; Touch Bar strip; multiple
  menu-bar sets; a Windows/Linux tray (Electron supports it; untested). **M, local+cloud**
- Low-resource part 3 (Ryan 2026-09-29, explicitly NOT now): a cheaper reverb for low-resource (short IR / algorithmic)
  and `latencyHint: 'playback'` while hidden — both are audible trade-offs; revisit after part 2 (drone freeze +
  AudioContext sleep) is measured on the Mac. **M, cloud**
- Menu-bar "low-resource" further: unload the reverb convolvers entirely when idle for > 5 min; sleep the AudioContext
  when no MIDI for 30 min and resume on the first message (needs a click-free wake path). **M, cloud**
- ~~Visual identity: every warmth direction ships as a Settings theme~~ **Done (cloud, 2026-09-30, CONTRACT_CHANGES
  `## themes-setup` … `## themes-final`):** 8 themes in Settings › Appearance (Classic, Sanctuary + Sanctuary Day,
  Daylight Stage + Day, Studio, Ember, Nave), **Sanctuary is the default**, the popover follows the theme, runtime
  switches render like a fresh boot (T1/T2 font fix), themes suite green for all 8. Still to verify on the Mac with the
  next drop (v1 gate above). What the theme agents deferred, because it is JS / copy / markup, not theme CSS:
  - **Daily hook**: the "Before the service" / "Light the room" / Today card / session sheet + line check / "last
    time" record start screen. Needs its own first-launch-of-the-day trigger (Electron autoplays, so `#overlay-start`
    never shows; OPTIONS §3 point 3) and a `worship-rig.lastSession` record. **M, cloud**
  - **Copy changes**: each direction's voice strings (Sanctuary §6.3, Ember §5, Studio §4, Daylight #6, Nave §5; e.g.
    "Preparing n of N", "That's the set. Thank you for serving.") and the tests that assert today's strings; "Extra ·
    add a sound" on the empty-slot well; FX captions "SPACE"/"ECHO" are upper case in the markup
    (`headerChipRow.js` `.toUpperCase()` → CSS uppercase in styles.css, themes-critic E2/S2). **S, cloud**
  - **EQ canvas theming**: `eq-keyboard.js` paints the plot, grid and key strip in fixed Classic slate/orange in every
    theme; read tokens instead (plus the `eq-keyboard.css` slate literals in unreached states). **S–M, cloud**
  - Smaller JS hooks: `slot.js` response-curve reference diagonal is hard-coded `rgba(255,255,255,.18)` (invisible on
    the Day themes' paper, themes-critic T3); Sanctuary's lancet lit on audibility, not `drone.mode`; Studio's
    one-shot lamp flash via a `.lit-now` class; pressed keys in the colour of the part that sounded; chord auto-fit;
    Daylight's Day · Stage · Auto switch and Lock forcing Stage. **S each, cloud**
  - Ember's `.song-name` line box is 50/48 (Young Serif metrics; no ink outside, themes-critic E1 title half): an
    `'Ember Title'` face with metric overrides, as done for the chord in themes-final. **S, cloud**
- Edit alternatives kept from the redesign: H-sheet "song-sheet" Edit (one sentence per sound) as an optional simple
  mode; B-v2 switch-bar variant. **L, cloud**
- EQ: octave-bar "simple mode" over the same bands (design/eq/octaves prototype); per-band type change stored as an
  enum in the UI (already in the engine); EQ presets per instrument family; copy EQ between slots/songs; a master EQ
  editor on the same piano axis. **M, cloud**
- Metronome / click track (tempo per song already exists) with a count-in and a MIDI-clock out option. **M, cloud**
- Chord / lyric / chart display on Perform (import ChordPro or plain text per song; auto-scroll; the chord readout
  already exists). **L, cloud**
- MIDI-out to hardware synths (send the transposed notes and program changes per song). **M, cloud+local test**
- Multitrack recording (per-slot stems + drone as separate WAVs; the recorder currently captures the master). **M, cloud**
- True shimmer reverb (pitch-shifted feedback path) and a real choir pad (formant + ensemble) — cut from v1 for sound
  quality reasons; needs listening iteration. **M, cloud + Ryan's ears**
- Planning Center Services import: pull the Sunday set (song names + keys) into a setlist. **M, cloud; needs API key**
- In-app GarageBand/Logic importer UI (today it's a CLI): pick instruments from a list, progress bar, run in a worker,
  then Rescan. **M, local (macOS paths) + cloud UI**
- Sample disk-streaming (play from disk with a small preload instead of decoding whole instruments) — would drop RAM from
  ~400–700 MB to tens of MB; large engine change. **L, cloud**
- Distribution page (Ryan 2026-09-30): a GitHub Pages site for the repo with a download of the built app (.dmg / .zip via
  GitHub Releases, built by CI on tag), a short "what it is" + screenshots (themes), install notes (Gatekeeper: ad-hoc
  signed, right-click › Open), and a changelog. Needs: `npm run build:mac` producing a .dmg (electron-builder `dmg`
  target; ~190 MB zip today), a release workflow on macos-14, and a decision on code-signing/notarization (Apple
  Developer ID costs money; without it users see the unidentified-developer warning). **M, local (CI/build) + cloud (page)**
  - Ryan 2026-09-30: the download must come with preset sounds and settings, i.e. a first launch that already plays:
    the 23 bundled CC-licensed sample sets + the 16 synths/organ (already in the app), the factory songs and setlists
    (`presets.js`), the FX presets, sensible default settings (Sanctuary theme, latency "Lowest", low-resource off,
    menu-bar set = first 3 songs), and a "Starter" backup JSON on the download page for anyone whose library got wiped.
    Optional extras on the page as separate downloads: additional CC0/CC-BY sample packs as pad packs (drop into
    My Pads), and per-genre setlists (worship / lofi / ambient). Never Apple-derived content. **S, cloud (presets +
    page) + local (release assets)**
- Older Macs / Intel (Ryan 2026-09-30): ship a universal or x64 build (electron-builder `arch: [arm64, x64]` or
  `universal`); nothing in the app is arm-specific, so this is mostly build config + size (universal ≈ 2× Electron, would
  break the 500 MB rule → ship two separate downloads instead). Oldest macOS is bound by Electron 44's floor. **S–M, local**
- Windows / Linux (Ryan 2026-09-30: only if it needs no overhaul): the renderer is portable Web Audio/Web MIDI; the
  Electron main uses macOS-only bits (tray template image, dock hide, app.hide, login item API, `open -a`, AppleScript
  in tests) that need per-platform branches, and the My Samples paths / GarageBand importer are macOS-only. Estimate:
  a Windows build is a **M** (platform branches + a Windows tray icon + NSIS target + testing on a Windows machine we
  don't have); Linux similar. Not an overhaul, but blocked on having a test machine — park until then.
- Auto-update / one-click update script (`git pull && npm run build:mac` behind a `.command`, or GitHub Releases +
  electron-updater; `app-update.yml` is already emitted but inert). **S (script) / M (updater), local**
- Set the app icon/branding properly (current icon is a placeholder monogram). **S, cloud/design**
- Expression pedal curve (linear/log) and a "hold pedal = sustain + drone swell" combo mode. **S, cloud**
- Song "scenes" (Sunday Keys "patch snapshots"): 2–3 saved wheel/level states per song, stepped by footswitch. **M, cloud**
- Second-window mode as a real feature (a read-only "stage display" window for the MD/vocalist with song, key, next). **M**
- Practice/warm-up mode: a loop of pads in a chosen key with a metronome and a timer; part of the "daily" idea. **M**

## B. Known quality items deferred (from reviews/audition/local findings)
- Classic base look (themes critics C1 / T4, in every theme, not theme regressions): Quick's "ON" pill 4.14:1 under
  the `.qs` box-shadow (styles.css); mini `.m-num` badges 3.49:1 under Classic (mini.css `--m-faint` fallback
  ≥ `#9a9185`); frozen drone faders under Lock lack `aria-disabled`; Quick › This Song overflows its sheet body
  by 27/5 px and clips the "Sustain pedal" caption. **S, cloud**
- From the hardware pass (2026-09-29, Ryan at the Keystation): **L-23** hold-to-unlock hint clipped at the window bottom
  (cosmetic, cloud, perform.js/styles.css); pedal-polarity wording — say "plug in with the pedal UP" or sample both
  states at connect; Bluetooth output measured 176 ms vs 20 ms on the dock — show a one-line latency warning when the
  output device's latency > 60 ms (Settings/Quick "This Mac"); MIDI Learn untested on hardware (no spare CC control on
  the 49es — retest with the second keyboard). **S, cloud**
- Piano samples at full length (Ryan 2026-09-30 follow-up): the bundled Salamander/VSCO files were trimmed to 20 s by
  the download scripts, so even with the new per-set cap a pedal-held low note ends at 20 s (originals ring 25–30 s).
  Re-fetch the low two octaves untrimmed (~+40–60 MB decoded, ~+15 MB on disk) if Ryan still hears it end early. **S, cloud**
- Memory: after the long-cap swap, the short neighbour copies stay cached unpinned (+160 MB until evicted) and the peak
  during a song switch rose 754 → ~810 MB; the pinned budget and soft cap hold, but a leaner swap (evict the short copy
  as soon as the long one is in) would keep the peak where it was. **S, cloud**
- Salamander piano has anti-correlated L/R on ~27 notes (spaced-pair recording, esp. C5); mitigated with
  `maxMonoLossDb`, but a per-note mid/side correction or a mono-safe sample set would be cleaner. **M, cloud**
- ~~Four GarageBand packs trip the DC-offset check~~ DONE 2026-09-28 (local 334334c: 10 Hz high-pass wrapper in
  `import-garageband.mjs`; DC now ≤ 2.8e-5). Follow-up: move the high-pass into `tools/exs/convert.mjs` `ffmpegArgs` as
  a `highpassHz` option instead of the wrapper. **S, local**
- Calibration by ear: `gainTrim`s are machine-calibrated; Ryan's listening notes should drive a manual pass, and the
  drone level target (−24 dBFS) is a guess. **S, cloud after LISTENING**
- Kalimba +23.6 dB trim: attacks may clip the limiter in the top register; consider a per-instrument ceiling. **S**
- ux-round2 leftovers not yet done: idle chord readout style decision (blank vs dimmed last chord), muted-strip
  pedal light, "EXPERIMENTAL" tag hidden at short heights in Perform (surface it in Edit only), Effects "goes in" rows
  mini-curve. **S, cloud**
- round3/round4 SUSPECTED items left in reviews/round3-*.md and round4-*.md (un-confirmed on Linux; may reproduce on
  Mac): re-check after the hardware pass. **S–M**
- MIDI "first input" heuristics: vendor list is hand-made; add a "remember per device name" UI in Settings with a
  "forget" button. **S, cloud**
- Chrome fallback: recording via File System Access writes a `.crswap` until close — document in-app, not only README. **S**
- Electron on macOS logged `Platform dependent initialization failed` for MIDI when launched from an agent shell;
  fine from Finder/Terminal — confirm during the hardware pass and, if it can recur, add a "MIDI needs a relaunch"
  hint. **S, local**
- Test flakiness under load: tap-tempo tolerance and identity-diff limits were widened; a proper fix is a
  fake-timer path for the tap tempo test and a seeded determinism mode that pins Chromium's input summation order (not
  possible) — accept tolerances. **–**
- `styles-edit.css` remaining `.ed-*` rules serve only Settings; move them into a settings stylesheet. **S, cloud**

## Size budget (Ryan, 2026-09-28): the packaged app must stay under 500 MB on disk; ~400 MB is fine.
- Today: 365 MB app / 193 MB zip (Electron ≈ 285 MB, our asar ≈ 81 MB of which samples 79 MB).
- Headroom ≈ 135 MB. Anything that adds bundled samples or media must be weighed against it; user-samples never count
  (they live outside the app). build-lint should fail the build above 480 MB (guard to add, local). **S, local**

## C. Process / tooling
- Replace the tarball drop with git: once the cloud can push (GitHub connector attached to the session), deliver as
  commits on a `cloud` branch and let `tools/sync-from-cloud.sh` become `git merge cloud`. **S, both**
- A shared status page (STATUS.md rendered) and a changelog generated from CONTRACT_CHANGES.md. **S, cloud**
- Move `reviews/*` and `design/*` PNGs out of the main tree (or git-lfs) before the repo grows further. **S, local**
- CI: GitHub Actions running `npm test -- --fast` on macOS runners (the suites already skip Linux-only checks). **S, local**

## D. Decided against (with the reason, so it isn't re-proposed blindly)
- Sampled GM pads/strings/organ with loop points: GM files are ~3 s with baked-in release; looping sounds bad. Synth
  and additive organ cover these.
- Storing EQ frequencies as MIDI-note floats: doesn't round-trip common Hz values (40 → 39.99…). Stored in Hz.
- A-rate automation on EQ params: 5× the CPU of k-rate for no audible gain at these rates.
- Always-wired 8-band EQ per slot: 1.5× the CPU; engaged-only chain with crossfade instead.
- Cutting held notes on song switch to free memory faster: violates the gapless rule; soft cap instead (L-10).
- Bundling GarageBand/Logic conversions: Apple-licensed personal content; local-only forever.
