# BACKLOG — ideas and deferred work (kept so nothing is lost)

Owner: cloud session writes it; either side may propose lines via `.cloud-outbox/status.md` (`BACKLOG: …`) or an
inbox file. Items move to COORDINATION.md "In flight" when scheduled. Last updated 2026-09-28T22:30Z.

Legend: **S/M/L** effort · **who** = which side is the natural owner (cloud = implementation, local = Mac/hardware).

## A. Features Ryan asked for or floated, not yet built
- Menu-bar mode v1.1: global hotkeys (`globalShortcut`) for next/prev mode, panic, master ±; Touch Bar strip; multiple
  menu-bar sets; a Windows/Linux tray (Electron supports it; untested). **M, local+cloud**
- Menu-bar "low-resource" further: unload the reverb convolvers entirely when idle for > 5 min; sleep the AudioContext
  when no MIDI for 30 min and resume on the first message (needs a click-free wake path). **M, cloud**
- Visual identity: whichever warmth direction Ryan picks ships as a Settings theme; the non-chosen directions stay as
  optional themes; a "daily hook" (Today card / before-service idle screen / warm-up mode) decided after the options
  page. **M, cloud**
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
- Auto-update / one-click update script (`git pull && npm run build:mac` behind a `.command`, or GitHub Releases +
  electron-updater; `app-update.yml` is already emitted but inert). **S (script) / M (updater), local**
- Set the app icon/branding properly (current icon is a placeholder monogram). **S, cloud/design**
- Expression pedal curve (linear/log) and a "hold pedal = sustain + drone swell" combo mode. **S, cloud**
- Song "scenes" (Sunday Keys "patch snapshots"): 2–3 saved wheel/level states per song, stepped by footswitch. **M, cloud**
- Second-window mode as a real feature (a read-only "stage display" window for the MD/vocalist with song, key, next). **M**
- Practice/warm-up mode: a loop of pads in a chosen key with a metronome and a timer; part of the "daily" idea. **M**

## B. Known quality items deferred (from reviews/audition/local findings)
- From the hardware pass (2026-09-29, Ryan at the Keystation): **L-23** hold-to-unlock hint clipped at the window bottom
  (cosmetic, cloud, perform.js/styles.css); pedal-polarity wording — say "plug in with the pedal UP" or sample both
  states at connect; Bluetooth output measured 176 ms vs 20 ms on the dock — show a one-line latency warning when the
  output device's latency > 60 ms (Settings/Quick "This Mac"); MIDI Learn untested on hardware (no spare CC control on
  the 49es — retest with the second keyboard). **S, cloud**
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
