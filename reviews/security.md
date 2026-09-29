# Security & privacy review (C6 critics, 2026-09-28)

Scope:
- `server.js` routes, and the Electron IPC surface in `main.js` + `preload.js` (read-only for this review).
- How the renderer handles imported files (My Samples pack manifests, library/song JSON imports, pad folders) and
  exported files (library/song JSON, recordings, backups).
- localStorage, the CSP, and HTML/eval sinks in `app/js/**`.
- Path handling in the GarageBand importer.

Threat model:
- a malicious pack manifest, or a malicious library/song JSON import;
- a hostile file in `~/Music/Worship Rig/Samples`;
- another local process talking to 127.0.0.1:8438;
- personal content leaking into the repo, the package or the public GitHub repo.

Scratch experiments are in `scratchpad/sec/`:
- `store-exp.mjs`: import attacks against the real store;
- `xss.mjs`: the real app in Chromium, with a hostile pack plus a hostile imported song, walked through Perform,
  Edit and the instrument picker;
- `srv.cjs`: the server probed as another local process;
- `quota.mjs`: Chromium's localStorage limit;
- the public-repo probe uses raw.githubusercontent.com.

Status legend:
- **CONFIRMED**: reproduced.
- **SUSPECTED**: found by reading the code, not run.
- **FIXED**: fixed in this run, with tests.
- **LOCAL**: the fix is requested in `reviews/for-local.md`.

## Summary

| # | Sev | Status | Where | One line |
|---|---|---|---|---|
| S1 | **major** | CONFIRMED · LOCAL (needs Ryan) | `tools/exs/fixtures/real/*.exs` | Six Apple GarageBand/Logic instrument files are publicly downloadable from `ryanmye/worship-rig` |
| S2 | minor→major (data) | CONFIRMED · FIXED | `app/js/store.js` importJSON | An oversized import makes every later save fail; a deeply nested one throws out of importJSON |
| S3 | minor (privacy) | CONFIRMED · FIXED | `app/js/store.js` exportJSON | Library exports carried the pad folder's `/Users/<account>/…` path and MIDI/audio device names and ids |
| S4 | minor | CONFIRMED · LOCAL | `server.js:633-696` | Any local process (any macOS account) can list and download all My Samples and pad audio, plus absolute paths |
| S5 | minor (hardening) | CONFIRMED · LOCAL | `server.js:264-289` | A pack manifest's `ext`/`notes` pass through unsanitised, so sample URLs can be steered anywhere on the origin |
| S6 | minor (defense in depth) | SUSPECTED · LOCAL | `main.js:279-299`, `:394-399` | `streamOpen` writes any extension in Recordings; `revealFile` is an existence oracle for any path |
| S7 | low | SUSPECTED · LOCAL | `tools/exs/sample-index.mjs:147`, `tools/import-garageband.mjs:80` | The importer trusts absolute sample paths stored in `.exs` files, and `--out` may point into `app/` |
| S8 | low | CONFIRMED · LOCAL | `test/integration/build-lint.mjs` | Only `user-samples/` is guarded; nothing stops a `personal-use` pack, a `.exs` or a `.caf` landing in `app/` or the repo |
| S9 | info (privacy) | CONFIRMED · Ryan | public repo `.cloud-outbox/status.md` | The public status log names the second GitHub account tied to the Mac's SSH key |
| S10 | info | CONFIRMED safe | renderer | No HTML/script injection from any import, pack or library field; no prototype pollution |
| S11 | info | — | CSP / Chrome origin | Hardening notes: Trusted Types, and squatting on the :8437 origin |

---

## S1 · major · CONFIRMED: Apple instrument files are in the public GitHub repo

- **Where:** `tools/exs/fixtures/real/` holds six files, about 946 KB:
  - Yamaha Grand Piano.exs
  - Grand Piano.exs
  - Steinway Grand Piano 2.exs
  - Steinway Piano 2.exs
  - Flea Market Wurli.exs
  - Lullaby Vibes.exs
- **What:** these are Apple's own GarageBand/Logic EXS instrument definitions: zone maps and Apple library paths,
  no audio. `docs/garageband-import.md:23-25` says: *"they are still Apple files: keep the repo private, or delete that
  folder (the tests then skip) before publishing it."* The repo was made public at 18:47Z (outbox line
  `REPO https://github.com/ryanmye/worship-rig public`), and the folder was published with it.
- **Measured:** `https://raw.githubusercontent.com/ryanmye/worship-rig/main/tools/exs/fixtures/real/Grand%20Piano.exs`
  returns 200. Its sha1 `d2518333…` equals the local file. The Yamaha and Steinway files are also served.
- **Other checks (all clean):**
  - No converted audio or `user-samples/` is on GitHub (`user-samples/README.txt` returns 404, and it is ignored).
  - The packaged app excludes `tools/`.
  - The `.exs` files contain only `/Library/Application Support/...` paths, nothing personal.
- **Impact:** Apple's software licence covers using this content in your own music, not redistributing Apple's library
  files. The damage is licensing and reputational, not a code vulnerability. This is also the project's own rule
  (CLAUDE.md: "Never commit… Apple-licensed personal content").
- **Fix (LOCAL; the history rewrite and visibility change need Ryan's explicit OK):**
  1. `git rm -r --cached tools/exs/fixtures/real`, and add `tools/exs/fixtures/real/` to `.gitignore`.
  2. Keep the files on the Mac, for example at `~/Music/Worship Rig/exs-fixtures/`. Let
     `test/unit/exs/real-files.test.mjs` read `RIG_EXS_FIXTURES` (it already skips when the files are absent), so
     CI simply skips it.
  3. Deleting the files leaves them in the git history. To remove them from GitHub fully, either rewrite history
     (`git filter-repo --path tools/exs/fixtures/real --invert-paths`, then force-push `main` and `menubar-local`)
     or make the repo private. Both are outward-facing actions: ask Ryan first.

## S2 · minor→major (data safety) · CONFIRMED · FIXED: hostile or oversized library/song imports

- **Where:** `app/js/store.js` importJSON (now lines ~1470-1501). It is called from `views/settings.js:676` (no
  try/catch) and `views/edit/panels/setlist.js:652`.
- **Attack 1: size.** Song objects keep unknown fields, and only `name` and `notes` are capped. A shared
  `.rig-song.json` with a 6 MB junk field imported fine. After that, every `persistNow` failed with
  `QuotaExceededError`. Chromium allows about **5,234,375 characters** of localStorage per origin (measured with
  `quota.mjs`). So *every later edit to the library went unsaved* until the user found and deleted that song. This
  was measured with a 5 MB quota adapter: import `ok:true`, then `could not save library: QuotaExceededError`.
- **Attack 2: nesting.** Measured:
  - A song with an unknown field nested 5,000–100,000 deep: `JSON.parse` accepts it, but `clone` / `deepFreeze`
    recurse, so **`importJSON` threw `RangeError: Maximum call stack size exceeded`**. In Settings › Import that is an
    unhandled rejection: a `console.error`, and no message for the user.
  - In a merge, `put()` writes song by song into `state`. So a later deep song could leave earlier songs half
    written, without a change event and without a `songOrder` entry.
- **Fix:**
  - `IMPORT_MAX_DEPTH = 64`, checked with an iterative walk (`nestsDeeperThan`) before any clone. A real library's
    deepest path is about 8.
  - `LIBRARY_MAX_CHARS = 2,000,000` compact characters for the library *after* the import (a merge counts the current
    library). That leaves room for the store's backup copy under the ~5.2 M limit. A real song is about 2 KB.
  - Text larger than 4 × the cap is refused before parsing.
  - All three cases return `{ok:false, error}`: "too large to import…" or "not a Worship Rig library or song". The
    existing toasts show the message.
- **Tests:** `test/phase1/shell/security.test.mjs`:
  - S2 deep: depths 65 / 5,000 / 100,000, replace and merge, object input, a hostile second song in a merge (no
    partial write), and EQ-depth songs still import.
  - S2 size: a 2 M-character field, 4 × cap text, 300 × 9 KB-notes songs; 20 of them still import.
  - Both tests fail on the old `store.js`, verified against a copy of the original.

## S3 · minor (privacy) · CONFIRMED · FIXED: library exports leaked device-local settings

- **Where:** `app/js/store.js` exportJSON (line ~1446). It is used by Export library (Settings and the Edit setlist
  menu) and by the Electron auto-backups.
- **What:** `settings` was exported whole. Measured: `padFolder: {"kind":"electron","path":"/Users/ryan/Music/…"}`
  (the macOS account name), `midiInputName` ("Ryan's KeyLab 61"-style device names), `midiInputId` and
  `outputDeviceId` (hardware ids). A library shared with a bandmate, or attached to an issue, carries all of them.
- **Why dropping them is free:** nothing reads them back. A replace-import keeps this machine's
  `DEVICE_LOCAL_SETTINGS` (`keep`), and a merge ignores settings. `menuBarMode` and `lowResource` are device-local
  too and are also left out.
- **Fix:** exportJSON filters out `DEVICE_LOCAL_SETTINGS`. Song exports never had settings. `midiLearn`
  (Next/Prev pedal mappings) stays in the export on purpose, because it is library behaviour.
- **Test:** security.test.mjs S3 checks that the export contains none of the four values, `pedalInvert` survives, and
  a replace-import on another store keeps that store's `outputDeviceId`.
- The shell unit suite is 188/188 with this change.

## S4 · minor · CONFIRMED · LOCAL: the server hands personal audio to any local process

- **Where:** `server.js:644-654` (`/api/user-samples/manifest.json`, `/api/user-samples`), `:680` (`/api/pads`),
  `:633` (`/api/health` gives `pid`).
- **Measured** (`srv.cjs`, as a plain Node client):
  - `/api/user-samples/manifest.json` → 200, with absolute `roots` (`/Users/<account>/Music/Worship Rig/Samples`) and
    every instrument's token-bearing layer URL.
  - Fetching that URL → 200 `audio/wav`.
  - `/api/user-samples` gives `dir`.
  - So the per-process `userToken` protects nothing against a local client, and the same holds for `/pads/<token>`
    via `/api/pads`.
  - Any macOS account on the machine can reach 127.0.0.1.
- **Not reachable from web pages (confirmed):**
  - DNS rebinding: `Host: evil.example` → 403.
  - The responses carry no `Access-Control-Allow-Origin`.
  - Files carry `Cross-Origin-Resource-Policy: same-origin`.
- **Minor:** `sendJSON` / `sendText` don't send `X-Content-Type-Options: nosniff`. ORB covers JSON today, so this is
  hygiene.
- **Fix, in order of value:**
  1. Drop `roots` from the HTTP manifest response. The engine doesn't use it; the Settings panel reads `dir` from
     `/api/user-samples`.
  2. Add `nosniff` to `sendJSON` / `sendText`.
  3. Electron only: have main.js add a per-launch secret header for our origin through
     `session.webRequest.onBeforeSendHeaders`, and have the server require it on `/api/user-samples*`, `/api/pads`,
     `/user-samples/`, `/pads/` when it was created with `{secret}`. The Chrome fallback can't hold a secret the page
     doesn't also expose, so it keeps today's behaviour.
- On a single-user Mac this is low, since same-user processes can already read `~/Music`. It matters for a shared
  church laptop with several accounts.

## S5 · minor (hardening) · CONFIRMED · LOCAL: pack manifests can steer sample URLs off the pack

- **Where:**
  - `server.js:264-289` `rewriteUserInstrument` passes `{...L}` and `{...inst}` through, with only `dir` and `files`
    sanitised (`safeRel`).
  - The engine builds `` `${dir}/${note}.${L.ext || ext}` `` (`engine/sampler.js:86`), and `new URL()` normalises
    the dot segments.
- **Measured** (`xss.mjs`): a pack with `"ext": "wav/../../../../api/heartbeat#"` made the app request
  `/user-samples/api/heartbeat`. With more `..` it reaches any same-origin path.
- **Impact today:** nil. It is same-origin and GET-only, the file routes serve only realpath-checked audio, and the
  pad token isn't guessable. But it breaks the documented invariant that sample URLs stay inside the pack, and it is
  the first thing a future state-changing GET route would trip over.
- **Fix:** in `rewriteUserInstrument`:
  - keep `ext` / `format` / `L.ext` only if they match `/^[a-z0-9]{1,5}$/i`;
  - keep a `notes[]` entry only if it matches `/^[A-G][#b]?-?\d$/` (or is a MIDI integer);
  - otherwise drop the layer and push an `errors[]` line.

## S6 · minor (defense in depth) · SUSPECTED · LOCAL: two over-broad IPC handlers

- **`rig:streamOpen` (`main.js:279-299`).**
  - A bare name gets `sanitizeFileName` but keeps any extension. An absolute path inside `recordingsDir()` keeps
    any name and extension, and nested folders are created.
  - The renderer then writes arbitrary bytes. Only a compromised renderer could exploit this, and S10 found no way
    to compromise it.
  - But such a renderer could drop `x.terminal` / `x.webloc` / `x.html` into `~/Music/Worship Rig/Recordings`. The
    app doesn't set `LSFileQuarantineEnabled`, so those files are not quarantined.
  - Fix: force the `.wav` extension (replace any other). Optionally refuse a first `streamWrite` at position 0 that
    doesn't start with `RIFF????WAVE`.
- **`rig:revealFile` (`main.js:394-399`).**
  - It accepts any existing path, so the `{ok}` versus `{error:'not found'}` answer is an existence oracle for the
    whole disk.
  - Fix: allow only paths under `recordingsDir()`, `backupsDir()` or the user-samples roots.
- **The `menubar-local` branch** (reviewed from GitHub raw):
  - The new handlers look right. `busPublish` is main-window only, messages are size-capped (64 KB / 4 KB) and
    `v:1`-validated, and `setMenuBarMode` / `setLoginItem` take booleans only.
  - The popover has its own navigation guards.
  - It shares the full preload, so `window.rig.streamOpen`, `backupNow` and so on exist in the popover too. A
    reduced preload for `mini.html` would be least-privilege. Informational.

## S7 · low · SUSPECTED · LOCAL: importer path trust

- **Absolute sample paths.** `tools/exs/sample-index.mjs:147` uses an `.exs` file's stored absolute sample path
  whenever the file exists. A third-party `.exs` dropped into an instrument root could name any readable file
  (`~/.ssh/id_ed25519`). ffmpeg or afconvert would then try to decode it into a pack under `~/Music/Worship
  Rig/Samples`. In practice non-audio fails to decode, and the pack stays local.
  - Fix: accept a stored path only under the known sample roots (`DEFAULT_SAMPLE_ROOTS` or `--samples`), and
    require an audio extension.
- **`--out` inside the app.** `--out` (`import-garageband.mjs:80`) accepts `<repo>/app/...`, which electron-builder
  packages.
  - Fix: refuse an `--out` inside `<repo>/app`, and warn when it is inside the repo but not under `user-samples/`.
- Checked and fine: ids go through `slugify` (`[a-z0-9-]`), and ffmpeg and afconvert run through
  `spawn` / `spawnSync` with argument arrays, so there is no shell.

## S8 · low · CONFIRMED · LOCAL: nothing guards the package or repo against personal content except `user-samples/`

- `build-lint.mjs` checks that `user-samples/` is excluded (outbox: "user-samples excluded yes"). No check covers:
  - a manifest entry with `"license": "personal-use"` inside the asar;
  - `.exs`, `.caf` or `.aif` files in the asar;
  - `app/samples/*` directories that `app/samples/manifest.json` doesn't list.

  S1 got into git exactly because no repo-side check exists.
- **Fix:**
  - Add those three asar checks.
  - Add a repo check (`git ls-files`) that fails on any `*.exs` / `*.caf` / `user-samples/**`, or on any tracked
    `manifest.json` containing `personal-use` (except the synthetic `tools/exs/fixtures/*.json`).

## S9 · info (privacy) · CONFIRMED · for Ryan

The public repo tracks `.cloud-outbox/status.md` on purpose. Its line 3 says the Mac's SSH key belongs to a second
GitHub account (named there). Other lines name the MIDI keyboard model and macOS build.
`reviews/idle-cpu-mac.md` has the machine details. None of this is a secret; it is simply public now. If that
account link isn't meant to be public, reword line 3 (history keeps it), or make the repo private (see S1).

## S10 · info · CONFIRMED safe: renderer injection and prototype pollution

- **HTML/script sinks** in `app/js/**`:
  - The only `innerHTML` is `views/perform.js:180`, with the static `ICONS` table. A hostile `group` name can only
    select `undefined` or a prototype function, which renders as inert text.
  - There is no `eval`, `new Function`, `insertAdjacentHTML` or `document.write`.
  - The dynamic `import()`s use constant paths (`main.js:785`, `engine/instruments.js:514`, `edit/shell.js:23`).
  - `h()` (`components/util.js`) sets text with `textContent`.
- **Live test** (`xss.mjs`, the real app on the real server):
  - The pack was a folder named `evil<i>pack<i>`, whose instrument name, group, license and attribution were all
    `<img src=x onerror=…>` payloads.
  - The imported song had payloads in name, notes, category and setlist name, with slots on the hostile pack.
  - The walk covered Perform, Edit (header, tabs, instrument picker with the "My Samples" group) and Settings.
  - Result: the payload showed as text 5 times, with `window.__pwned` unset, no `img[src=x]`, no CSP violation and
    0 console errors.
  - CSP (`script-src 'self' blob:`, no `unsafe-inline`) would block inline handlers anyway.
- **Prototype pollution:**
  - `__proto__`, `constructor` and `toString` keys in an import were tried at the top level, in songs, setlists,
    patch, slot, instrument, params, drone, settings and midiLearn, with merge and with replace.
  - `store.set()` was tried with reserved path segments.
  - Nothing reached `Object.prototype`, and the library maps keep only the real song.
  - Pinned as test S1. (`isReservedKey` / `entriesFromArray` / `cleanInstrumentParams` already covered this.)
- **Menu-bar bus** (`shared/bus.js`): every command is validated against contract v1 (type whitelist, per-type
  payload ranges). BroadcastChannel is same-origin.
- **Exported file names:** recordings use a date stamp. Song exports use `safeName` (strips `\/:*?"<>|`). Electron
  runs bare names through `sanitizeFileName`.
- **localStorage contents:**
  - `rig.v1`: the library, including the device settings (local only, fine);
  - `rig.v1.backup-<ts>`: at most 3;
  - `worship-rig.edit2.sections`: UI state;
  - IndexedDB `worship-rig-ui/handles/padFolder`: the Chrome FSA handle.
  - No credentials or tokens.
- **Recordings:** they go to `~/Music/Worship Rig/Recordings` (Electron), Downloads or an FSA file (Chrome), or OPFS
  (fallback). None are under the repo. `.gitignore` covers `user-samples/`, `audition/*.wav` and `test/logs/`.

## S11 · info: hardening notes (no action required)

- **CSP.** Adding `require-trusted-types-for 'script'` would turn any future `innerHTML` of user data into a hard
  error. The one `ICONS` use would move to a named policy. Worth it only if the UI grows HTML templating.
- **Chrome fallback origin squatting.** localStorage and the FSA pad-folder permission belong to the origin
  `http://127.0.0.1:8437`, not to our server. If another account's process binds :8437 while the rig is closed and the
  user opens that URL, that process gets the library.
  - serve.mjs `reuse:true` also trusts any process that answers `/api/health` with `app:'worship-rig'`.
  - Electron is not affected: it has its own profile and `reuse:false`.
  - Only relevant with several macOS accounts.
- **MIDI.** Electron must grant `midiSysex` for Web MIDI at all (CLAUDE.md). The renderer never requests sysex output,
  but a hypothetical renderer compromise could send sysex (firmware writes on some synths). This is one more reason
  to keep S10's no-HTML rule.
