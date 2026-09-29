# CLAUDE.md: notes for coding sessions on Worship Rig

Worship Rig is a live keys/pads rig: an Electron app plus a Chrome fallback. The web app is plain ES modules in `app/`,
with no bundler. Read `docs/architecture.md` first (10 minutes). `SPEC.md` is the original contract, and
`CONTRACT_CHANGES.md` logs every interface change, with measurements.

## Run, test, build

```sh
npm install                       # once (Electron 44, electron-builder, Playwright)
npx playwright install chromium   # once, for the browser suites
npm start                         # Electron app from source (server on 127.0.0.1:8438)
npm run serve                     # Chrome version (server on :8437, opens a Chrome app window)
npm test                          # all suites except the 20-min soak (test/run-all.mjs --skip soak)
node test/run-all.mjs --fast      # also skips the Electron suites; prints a table, logs in test/logs/
node test/run-all.mjs --only shell,engine
node test/phase1/shell/run.mjs [--only unit|browser|electron]
node --test test/phase1/shell/store.test.mjs   # a single node:test file
npm run build:mac                 # → dist/mac-arm64/Worship Rig.app (+ zip); build/afterPack.js ad-hoc codesigns
```

On Linux the Electron suites need `xvfb-run`. On the Mac they run directly. The suites bind fixed ports (8438), so
run them one at a time; `run-all` does that for you.

## Conventions

- **File ownership no longer applies.** The "[shell]/[ui]/[engine-core]…" owners in SPEC §1 were for the parallel
  build. Any session may edit any file. Keep the module boundaries:
  - Views call `store.set(...)` for anything persisted and `controller.*` for actions. Views never call the engine.
  - `controller.js` is the only module that talks to both store and engine.
  - `shared/` stays pure: no DOM and no Web Audio.
- **No direct AudioParam automation.** Always use `shared/automation.js` (`setNow`, `rampTo`, `glideTo`, `linearTo`,
  `holdAndFade`) or the engine helpers `fx.linFrom` / `fx.glideFrom` / `equalPowerFade`. Chromium's
  `cancelAndHoldAtTime` doesn't anchor a following ramp. Details are in CONTRACT_CHANGES "engine-instruments" and
  "fixups #1".
- **Glides and linear ramps scheduled ahead of "now" must pass `{from}`**, for example
  `glideTo(p, v, when, dur, {from: tracked})`. Without it the ramp starts from `param.value`, which is only right when
  `when ≈ currentTime`. Never write `setNow(x, t); linearTo(…, t)` without `{from: x}`.
- **Every time-sensitive engine call takes `{when}`, and there are no `setTimeout`s in the engine.** Use `AudioTimer`
  or `engine.at(when, cb)`. This keeps OfflineAudioContext renders deterministic, and the tests, calibration and
  audition depend on that.
- **Parameters come from the PARAMS table** in `shared/params.js`. The store (validation and clamping), the
  controller (store→engine diff) and the UI all read it. To add a param, add the row and implement it in
  `engine.setParam`. The store and controller pick it up without changes; there are tests for exactly that
  (`test/phase1/shell/shell3.test.mjs`).
- **Store schema** is `SCHEMA = 1`. `migrate()` is idempotent and keeps unknown fields. Optional fields (slot
  `width`/`eq`, `fx.eq`, `fx.comp`) stay absent until they are set.
- **Factory songs** (`presets.js`) keep stable ids `factory:<slug>`. To add a song:
  1. Append it to `DEFS` with `since: <n>`.
  2. Bump `FACTORY_VERSION` to `<n>`.
  3. `store.seedFactory()` then adds it to existing libraries, once, at the end of the library order.

  Use the named `fx-presets.js` spaces and echoes, spread in unchanged, so the UI shows their names.
- **Zero `console.error`, and no 404s.** Chromium logs every failed fetch as a console error. Optional resources are
  gated: the My Samples manifest is only requested when `/api/health` says `userSamples: true`. The Electron self-test
  (`RIG_SELFTEST=1`) also counts HTTP ≥ 400 responses.
- **Log interface changes** in a new `## <topic>` section of `CONTRACT_CHANGES.md`. Record what changed, why, and
  the numbers.
- Style: 2 spaces, single quotes, semicolons, lines ≤ 120 characters, JSDoc on exported functions. Comments should
  explain why, and cite the review/finding id (for example `M5`, `engine-core #18`).

## Edit view (H-v2, `app/js/views/edit/`)

- `views/edit/CONTRACT.md` is the reference: module map, the selection model (`ctx.editState`), the panel API and
  ctx, DOM/CSS rules and the test harness. main.js mounts `edit/shell.js` (`mountEdit`); the old `views/edit.js`
  is gone.
- **Shell** (`shell.js`): the layout, 7 block tabs (Keys · Pad · Extra · Bass · Drone | Effects · Master) with
  summaries and changed dots, Show wiring, and one ctx per mounted panel. Everything a panel registers through its
  ctx (subscriptions, listeners, Esc handlers, leave-song hooks) is released when it unmounts.
- **Panels** (`panels/*.js`, one CSS file each): `slot` (Keys/Pad/Extra/Bass), `drone`, `effects`, `master` (incl.
  Wheels & pedal), `song` (Easy Transpose, tempo, notes; opened by the header chips), and the regions
  `song-header`, `setlist`, `bottom`. Panels write through `ctx.set` / store helpers / `controller.*` only.
- **Shared** (`lib.js`): `createBinder` (targeted store → view refresh; `destroy()` also unsubscribes), `section`
  (open state in `localStorage['worship-rig.edit2.sections']`), `wordSlider`, `sentence`, icons, labels.
- **CSS**: `styles-edit-v2.css` imports `base.css` first, then the panel files, so panel rules win ties. Every
  selector is scoped under `.ev2`.
- **Changed dots** count against Perform's Revert snapshot (`ctx.getBaseline()` from main.js), so both views agree.
- **Slot EQ**: Advanced › Tone mounts `components/eq-keyboard.js` `eqKeyboard` only while Advanced and Tone are
  open, and destroys it on close, rebuild and unmount; `eqMiniCurve` sits in the title bar. The Brightness/Warmth
  sliders on the strip's shelves read `readEq` and write `shelfWrites` (`shared/eq-math.js`): the legacy
  `eq.low`/`eq.high` rows stop acting once a band has b-rows.
- **Tests**: `node test/phase2/edit-v2/run.mjs [--only slot,integration]`. Panel files use the harness
  (`harness.mjs`: one panel or the whole view, real store/engine/controller); `integration.test.mjs` runs the real
  app. One process per file, 900 s budget per file. Settings has its own suite (`test/phase2/settings/run.mjs`).

## Where things live

- Levels and calibration:
  - Sampler trims: `gainTrim` (dB) per instrument in `app/samples/manifest.json`.
  - Synth, organ and drone trims: `app/js/engine/gain-trims.json`.
  - `synth-extra.js` folds its calibration into `PATCHES[].gainTrim`, applied inside the instrument.
  - Regenerate with `node tools/calibrate.mjs`, then check with `node tools/audition.mjs`. That writes about 150 MB
    of WAVs to `audition/` (git-ignored). Findings are in `reviews/audition-findings.md`.
- Sample sources and processing: `tools/samples/*` and `LICENSES.md`. Musyng Kite is **CC BY-SA 3.0**, not MIT, so
  keep attribution and share-alike.
- My Samples:
  - Scan roots are `<repo>/user-samples/` and `~/Music/Worship Rig/Samples/`; `RIG_USER_SAMPLES` overrides them.
  - The server code is in `server.js` (`scanUserSamples`). The importer is `tools/import-garageband.mjs`, documented
    in `docs/garageband-import.md`.
  - **GarageBand/Logic conversions are Apple-licensed personal content. Never commit them, package them or copy them
    into `app/`.** `.gitignore` and electron-builder `files` both exclude `user-samples/`.
- Electron env overrides for tests: `RIG_APP_DIR`, `RIG_PORT`, `RIG_PADS_DIR`, `RIG_USER_DATA`,
  `RIG_RECORDINGS_DIR`, `RIG_USER_SAMPLES`, `RIG_SELFTEST=1`, `RIG_DEBUG_PERMS=1`.

## Known caveats

- **Chromium sums a node's inputs in hash-set order**, so renders differ by about 1e-6 from run to run. Use
  tolerances (≈1e-5) and never test for bit-exact equality.
- **Web Audio `BiquadFilter.Q` for lowpass/highpass is in dB**, not linear. Butterworth is −3.01 dB. Use
  `voice.qDb()` or `fx.BUTTER2_Q`.
- **Electron gates Web MIDI behind the `midiSysex` permission**, even for `{sysex:false}`. main.js allows `midi` and
  `midiSysex` for our own origin only.
- **localStorage is per origin (port).** Chrome (:8437) and the Mac app (:8438) keep separate libraries. If 8438 is
  busy, the Mac app uses another port, and the library looks empty until you import a backup.
- Playwright `page.evaluate` runs with a user gesture, so an AudioContext created inside it is never
  autoplay-blocked. The app's own context is.
- `tools/calibrate.mjs` plays its notes at the commit instant, which trims decaying instruments slightly hot. It also
  doesn't know synth-extra's `calibWindow` (pluck). See CONTRACT_CHANGES "## synth-extra".
- New My Samples packs need `engine.reloadManifests()` to show up live. If the engine lacks it,
  `controller.rescanUserSamples()` warns and asks for a restart.
- The GarageBand importer has been validated against synthetic `.exs` files only. Real GarageBand content has to be
  checked on the Mac (see `docs/garageband-import.md`).
- The Linux CI container has no MIDI device and only 2 slow CPUs. Timing-heavy engine suites are slower there, and
  MIDI init degrades to a warning.

## Size budget
Ryan's rule (2026-09-28): the packaged `Worship Rig.app` stays under **500 MB** on disk (~400 MB is the comfort zone).
Today it is 365 MB, of which Electron is ~285 MB and bundled samples ~79 MB. Anything that adds bundled media must fit
the remaining headroom; `user-samples/` is outside the app and doesn't count. build-lint guards this (fail > 480 MB).
