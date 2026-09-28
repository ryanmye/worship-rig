# Worship Rig tests

Everything runs from the repo root with Node ≥ 22.12 (Electron 44's minimum). The browser suites need Playwright's
Chromium, and the Electron suites need `xvfb-run` on Linux. Electron 44's npm package has no postinstall: the binary
is downloaded on first use (`npm start`, `npx electron`, or build-lint), from the cache when there is one.

```sh
npm test                               # every suite except the 20-min soak  (= node test/run-all.mjs --skip soak)
node test/run-all.mjs                  # everything, including the 20-min soak
node test/run-all.mjs --fast           # no soak, no Electron (skips shell's Electron boot, electron-full, build-lint)
node test/run-all.mjs --only phase1    # suite names or groups: unit, phase1, phase2, integration, electron, soak
node test/run-all.mjs --skip engine,ui-edit
node test/run-all.mjs --only soak --soak-minutes 5
node test/run-all.mjs --list           # show the suites and their commands
npm test -- --fast                     # extra flags pass through npm
```

`run-all` runs the suites one after another, never in parallel, because several of them bind fixed ports (8438) and
Chromium plus Electron together would overload a small box. It writes each suite's full stdout and stderr to
`test/logs/<suite>.log`, prints a summary table (also saved to `test/logs/summary.txt`), and exits non-zero if any
suite fails or times out. If you name a suite in `--only`, it runs even when `--fast` or `--skip` would otherwise
drop it. On a timeout (per suite, listed below), `run-all` kills the suite's whole process group, including any
browser, Xvfb or Electron it started. The first Ctrl+C stops the current suite and skips the rest.

Every suite can also be run on its own, as shown in the "command" column.

## Suites

Times were measured on the 2-vCPU Linux container. On an M-series Mac, expect them to be about half.

| suite | command | covers | time |
|---|---|---|---|
| unit | `node --test "test/unit/**/*.test.mjs"` | phase0 shared modules: music, params, automation, prng, keydetect (≥ 20 cases), chords, wav | ~1 s |
| engine | `node test/phase1/engine/run.mjs [filter]` | engine-core in Chromium. **Offline** (seeded OfflineAudioContext): sustain deferral, re-strike, mono, split, transpose FFT, gapless switch, lofi 0 ≡ none, stuck-note fuzz, click detector. **Real-time**: recorder-tap RMS, drone files mode, chord-follow. Also `js/engine/test.html`. Zero console.error. | ~2.5 min |
| instruments | `node test/phase1/instruments/run.mjs` | synth, organ and voice: per-patch level, release during attack, voice stealing, `kill()`/`dispose()` bookkeeping, … | ~1 min |
| synth-extra | `node test/phase1/synth-extra/run.mjs` | the extra synth patches (`engine/synth-extra.js`): per-patch checks and trims. Skipped when the runner does not exist. | ~1–2 min |
| shell | `node test/phase1/shell/run.mjs [--only unit\|browser\|electron] [--skip …]` | node:test for store, controller (fake engine), midi `_inject`, presets and the WAV header. Playwright: server Range/MIME/traversal, recorder to OPFS/mock rig. Electron boot on a fixture app. `--fast` passes `--skip electron`. | ~1 min (+~30 s Electron) |
| ui-core | `node test/phase2/ui-core/run.mjs` | the real app in Chromium: Perform view, top bar, overlay, sound and release per song, screenshots in `test/phase2/ui-core/screenshots/` | ~2–3 min |
| ui-edit | `node test/phase2/ui-edit/run.mjs` (`UIEDIT_MODES=app\|fixture`) | Edit view and Settings modal against the real store/engine/controller, plus the fallback component set. Screenshots. | ~2–3 min |
| chrome-fallback | `node test/integration/smoke-chrome-fallback.mjs` | `node serve.mjs --port <free>`, then Chromium **without** the autoplay flag: the start overlay appears, a click starts audio, and computer key A makes sound. `/api/health` from Node and from the page. A second `serve.mjs` on the same port reuses the server, exits 0 and opens nothing. `--open` while a window heartbeats opens nothing; `--open` on a server nobody has visited opens exactly one app window. A fake `google-chrome`/`chromium`/`xdg-open` on `PATH` records launches, so nothing real opens. SIGINT stops the server cleanly. | ~40 s |
| electron-full | `node test/integration/electron-full.mjs [--keep]` | the **real** app in Electron, run with `xvfb-run -a npx electron . --no-sandbox`. Run 1 (`RIG_SELFTEST=1`): loads from `127.0.0.1:8438` (or a free port if 8438 is busy), zero console.error, no failed resource loads, `window.__rig` exists, 3 songs (grand piano, pad + drone, lofi) selected through the controller all sound on the analysers with no NaN, and a 2 s recording through `controller.record()` lands in the recordings folder as a valid 16-bit stereo WAV of about 2 s. Exit 0, port released, no leftover process. Run 2 (normal quit path): record 1 s, `window.close()`, then the app exits 0 on its own and the take is finalized. | ~35 s |
| build-lint | `node test/integration/build-lint.mjs [--keep] [--no-boot]` | `electron-builder --linux dir` (`--mac dir` on macOS) with the repo's own `build` config into a temp dir, using Electron from `node_modules`, so nothing is downloaded. Asserts the asar contains `main.js`, `preload.js`, `server.js`, `README.md`, `LICENSES.md`, `app/index.html`, `app/samples/manifest.json`, every sample file the manifest lists and every `app/` file on disk. It must not contain `app/js/engine/test.html`, test, tools, audition, reviews or dev deps. Then boots the packaged binary under xvfb and checks for zero console.error. The temp dir (~300 MB) is deleted afterwards. | ~40 s |
| soak | `node test/integration/soak.mjs [--minutes 20] [--fast] [--seed N] [--sample-sec 30] [--no-setlist]` | 20 min (2 with `--fast`) of seeded, real-time random playing against the real app in headless Chromium: notes and chords, sustain, wheel sweeps, bends, a song switch every 20–40 s (every third one to a lofi song, half of them while holding a chord), panic, and drone key changes. Samples `_debugStats()` and `performance.memory` every 30 s into `test/logs/soak.csv`. At the end: keyboard voices reach 0 after release without a panic, node count is within +10 % of the post-warm-up baseline (same song, same key), JS heap growth after GC is < 20 MB, decoded samples stay under the engine cache cap (`decodedMB ≤ capMB` in every row), zero console.error, and no NaN on the analysers (checked every 250 ms). `--no-setlist` deselects the seeded "My Set" first, so pins follow the library order. | minutes + ~1 min |

`tools/calibrate.mjs` and `tools/audition.mjs` are **not** part of `run-all`. Calibrate rewrites the trims in
`manifest.json` and `gain-trims.json`, and audition renders about 150 MB of WAVs to `audition/`. Run them by hand
(SPEC §12).

## What "zero console.error" means per environment

- **Chromium (Playwright)**: every `console.error` and every page error counts. So does every failed resource load,
  because Chromium logs `Failed to load resource: … 404` as a console error. A sample listed in the manifest but
  missing on disk fails every Chromium suite that loads that instrument.
- **Electron**: `main.js`'s self-test (`RIG_SELFTEST=1`) counts `console-message` events, which carry only console
  API calls, **and** hooks `session.webRequest.onCompleted`: every response ≥ 400 from our own origin adds one to
  `consoleErrors` and is listed in the report's `httpErrors` (CONTRACT_CHANGES "shell-3" #3). So a 404 fails the
  shell suite's Electron boot (whose fixture makes one deliberate `/__selftest-404.json` request and asserts it is
  the only error, proving 404s are visible), build-lint's packaged boot and `electron-full`. `electron-full` also
  still reads `performance.getEntriesByType('resource')` for `responseStatus ≥ 400`, as a second, page-side check.
  A resource that fails *without* an HTTP response (connection refused, blocked by CSP) is still only visible if the
  page logs it.

## Environment caveats (Linux container)

- **No MIDI device.** Headless Chromium reports MIDI as denied or pending even after `grantPermissions(['midi'])`.
  Electron under xvfb warns `MIDI unavailable (failed): Platform dependent initialization failed`. MIDI is covered by
  `midi._inject` in the shell's node tests. The real keyboard, pedal and hot-plug are on the manual Mac checklist in
  the top-level README.
- **No audio device.** Chromium and Electron fall back to a fake output stream. The AudioContext runs and advances,
  and analysers and recordings work, but the reported latency is fake (about 40 ms, which triggers the ≥ 40 ms
  warning in screenshots). Output-device selection (`setSinkId`) can't be exercised.
- **Autoplay.** Headless Chromium applies the default autoplay policy to contexts the page creates by itself.
  `chrome-fallback` relies on that to show the start overlay. Contexts created inside `page.evaluate` are *not*
  blocked, because Playwright evaluates with a user gesture. Don't use them to probe the policy.
- **Electron needs `--no-sandbox`** as root in a container and `xvfb-run` for a display. On a Mac, electron-full runs
  `npx electron .` directly.
- **Ports.** The Electron suites use 8438, the app's fixed port, when it is free. The shell's Electron boot requires
  it. Stop any running Worship Rig app before `npm test`.
- **Disk.** build-lint needs about 400 MB free in the temp dir while it runs.
- **Mac packaging** (`npm run build:mac`, ad-hoc codesign in `build/afterPack.js`) can only be checked on a Mac.
  build-lint verifies the same `files` config on a Linux `dir` build.

## Files

```
test/run-all.mjs                 orchestrator (this README)
test/logs/                       <suite>.log, summary.txt, soak.csv (git-ignored)
test/unit/**                     phase0 node:test files
test/phase1/{engine,instruments,synth-extra,shell}/run.mjs
test/phase2/{ui-core,ui-edit}/run.mjs
test/integration/lib.mjs         shared helpers: free ports, app wrapper with probe injection, WAV inspection, checker
test/integration/electron-full.mjs
test/integration/soak.mjs
test/integration/smoke-chrome-fallback.mjs
test/integration/build-lint.mjs
```
