# Integration harness findings

Harness: `test/run-all.mjs`, plus `test/integration/{electron-full,soak,smoke-chrome-fallback,build-lint}.mjs`. See
`test/README.md` for how to run it.

## Hook status: no new app hook needed

`electron-full` drives the real app through `RIG_SELFTEST=1` and `RIG_APP_DIR`. `RIG_APP_DIR` points at a
throw-away dir where every entry is a symlink into the real `app/`. Only `index.html` is copied, with one extra
`<script type="module" src="./__it/probe.js">` added. The CSP (`script-src 'self'`) allows the probe because it is
same-origin. The probe uses `window.__rig` and sets `window.__RIG_SELFTEST__`. `main.js` is untouched and still has
no test-only code paths beyond the existing self-test.

## Findings for other owners

1. **samples: `ep-rhodes` manifest lists 8 files that don't exist** (seen at 01:16 while the samples agent was
   editing): `A0 Bb0 B0 Ab7 A7 Bb7 B7 C8 .mp3`. Every Chromium suite that loads ep-rhodes (engine `test.html`, ui-core,
   ui-edit, chrome-fallback) fails "zero console.error" with `Failed to load resource: 404`, and build-lint fails
   "every sample the manifest lists is packaged". Fix: either trim `notes` to the files on disk or add the files.
2. **shell: the Electron self-test can't see 404s.** `installSelftest` counts `console-message` events. In Electron
   those carry only console API calls, not Chromium's own `Failed to load resource` network errors. So
   `electron.boot.mjs`'s "zero console errors" (and any future one) passes even when samples 404. `electron-full`
   works around this by reading `performance.getEntriesByType('resource')` for `responseStatus ≥ 400`. Suggestion:
   also hook `session.webRequest.onCompleted` (statusCode ≥ 400, for our origin) in `installSelftest` and count those
   as errors.
3. **engine: decoded sample cache is ~425 MB after visiting every factory song** (`_debugStats().decodedMB`, soak
   warm-up). It is stable over the soak with no growth, but on an 8 GB Mac with other apps open that is a lot.
   Consider evicting instruments that no song in the current setlist uses.
4. **samples: work files inside `app/samples` get packaged.** One build-lint run failed with electron-builder
   `ENOENT … app/samples/upright-piano/dyn3/A0.mp3.trim.wav`: a samples tool writes temp files next to the samples,
   and `build.files` includes `app/**/*`. Write temp files outside `app/`, or add `!app/samples/**/*.trim.wav`.
   Related: `upright-piano`, `harpsichord`, `bright-piano` and `clavinet` dirs exist on disk but not in the manifest
   (7 instruments). While they stay unlisted they are packaged as dead weight (asar 62 → 77 MB).
5. **Test gotcha (all Playwright suites):** `page.evaluate` runs with a user gesture, so an AudioContext created
   inside `evaluate` is never blocked by the autoplay policy. The app's own context, created by page script, *is*
   blocked when `--autoplay-policy=no-user-gesture-required` is not passed. `chrome-fallback` relies on that to
   exercise the start overlay.

## What the new suites cover (all green against the app as of this run, except item 1)

- electron-full (28 checks): real app in Electron under xvfb. Loads from 127.0.0.1:8438, zero console.error,
  `window.__rig`, 3 songs sound with no NaN, a 2 s recording through `controller.record()` is a valid WAV in
  `RIG_RECORDINGS_DIR`, keyboard voices reach 0 after release, exit 0 with the port released and no leftover
  process. Normal quit path: `window.close()` → exit 0, and the take is finalized.
- smoke-chrome-fallback (17): serve.mjs, start overlay, key A sounds, `/api/health`, reuse without a second window
  (heartbeat-aware `--open`), SIGINT shutdown.
- build-lint (26): `electron-builder --linux dir` asar contents, test.html excluded, no dev files, the packaged app
  boots with zero console.error.
- soak (11): 2 min run passed. Nodes 180 → 181 (+0.6 %), heap +0.17 MB, voices back to 0, no NaN, zero
  console.error.

## Round 2 (integration-2, after all round-2 fixes)

Full run-all (`--soak-minutes 10`): 10/11 first pass, build-lint 26/26 on re-run (xvfb-run exit-5 flake, see
CONTRACT_CHANGES "integration-2"). Status of the round-1 items:

1. ep-rhodes missing files: **fixed** (build-lint: every listed sample packaged, 1999 files, 23 instruments).
2. Electron self-test blind to 404s: **fixed** in shell-3 #3.
3. Decoded sample cache: **worse, still open**. The soak now reports `decodedMB` **1023.6 MB** after the warm-up
   (19 songs), flat for the whole run (no leak). Cause: with no setlist chosen, `controller.preloadSetlist()` uses
   `store.navIds()` = the whole library and calls `engine.preload(…, {pin:'replace'})`, so every sample of every
   factory song is pinned. `BufferCache` never evicts pinned entries, so its 700 MB `capBytes` is exceeded by ~320 MB
   and cannot be enforced. On an 8 GB Mac with a browser and slides open this is the most likely real-world
   problem (memory pressure → audio glitches), and it grows with every sampled song the user adds. Options, not
   done here because it is a policy decision: pin only an explicit setlist (library view: pin prev/current/next
   and let the LRU handle the rest), or cap the pinned bytes and fall back to neighbour pins with a status warning.
4. Temp files / unlisted instrument dirs: **fixed** (`!app/samples/**/*.trim.wav`; the four dirs are now listed).
   app.asar is 77.1 MB, 2091 entries.
