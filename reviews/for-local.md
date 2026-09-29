# Requests for the LOCAL (Mac) session

Append-only. Each entry: who, what, why.

## review4-perform (2026-09-28)
- **L-20 (ui-core `polish-2A responsive`, `div.song-name` 42 > 40 at 1280×800):** this is reproduced on Linux by
  forcing Carlito on `.song-name` (42/40 at 1280×800, 45/42 at 1440×900). The cause is `line-height: 1.05` in an
  `overflow:hidden` box (styles.css:640). The fix is cloud-side (round4-perform P2). After the next drop, please re-run
  `node test/phase2/ui-core/run.mjs` on the Mac, and report `scrollHeight/clientHeight` of `.song-name` at 1280×800,
  1440×900 and 1024×700 with SF Pro. The new test drops the +1 px slack.
- Once that drop lands, please do a quick visual check on the Mac:
  - tap Revert (with a change), and tap Lock while locked;
  - check that the "press and hold (0.6 s)" caption is fully readable (round4-perform P1; today it renders below the
    window edge).

## round4-controller fixer (2026-09-28)
- **Verify C2 on the Mac** after the next drop (the reviewer's request; the fix is in, `## round4-controller`). Build
  or `npm start`, make a setlist **[Grand Piano, Prayer Wash, Upright Pad, Building Swell]**, select it, quit,
  relaunch. Poll `__rig.controller.status.memory` every 250 ms for the first 30 s and report
  `C2_MAC pinnedMax=<MB> mode=<final mode> setMB=<MB> toast=<y/n>`. Expected: pinnedMax ≤ 600, and no "pinned
  samples … exceed the 700 MB cache cap" toast (that text now goes to the console only). If upright really decodes
  to ~421 MB there, the set ends `large-set` with setMB ≈ 754.
- If your footswitch is set to **toggle** mode, learned Next/Prev act on every other press (C9 fixed press-only
  pedals, not toggle ones). Momentary mode works. Worth a note in the README's pedal section.

## round4-edit-lib fixer (2026-09-28)
- **Verify M1 on the Mac** after the next drop (fix in `## round4-edit-lib`; no main.js change needed). In Edit ›
  Song, type into song A's notes, click elsewhere, switch to song B (MIDI Next or a setlist tap), go to Perform and
  press ⌘Z (and try Edit ▸ Undo from the menu bar). Report `M1_MAC aNotesUnchanged=<y/n>`. Before the fix A's notes
  became B's.
- **Unverified, FYI (not a round4 finding):** in the Linux headless shell a blob download whose `download` name
  has non-ASCII characters ("Café.rig-song.json", "… さんび.rig-song.json") arrives as `download` (ASCII names are
  kept). This is probably headless/locale-specific. Please check once on the Mac: rename a song to "Café", then Edit
  ⋯ Song menu › Export song, in the built app. Report `EXPORT_NONASCII name=<saved file name>`.

## round4-perform fixer (2026-09-28)
- **L-20 fix (P2):** the fix is line-height **1.25**, not the 1.12 that review4-perform proposed (Carlito still overflowed
  at 1.12). After the next drop, run `node test/phase2/ui-core/run.mjs` on the Mac. The new test
  "round4-perform P2" prints `# Carlito … sh/ch …` rows. On the Mac, Carlito is probably absent and falls back to the
  system font, which is the case that matters. Report `L20_MAC <pass/fail> 1280x800=<sh>/<ch>`. The polish-2A
  responsive test should also pass there now (42 > 40 was the failure).
- Visual check (P1): tap Revert (with a change), and tap Lock while locked. The amber "press and hold (0.6 s)"
  caption now shows above the button. Report `P1_MAC ok/not`.

## idle-cpu profiler (2026-09-28; reviews/idle-cpu.md, CONTRACT_CHANGES `## idle-cpu`)
- **Engine fix in the next drop:** an idle warm-pad (Sunday Pad + Piano, Prayer Wash, Organ Swell…) no longer keeps
  the reverb and FX chain processing silence. After the drop, please re-measure on the Mac:
  - (a) Sunday Pad + Piano, drone on;
  - (b) the same with the drone off;
  - (b′) (b) after playing one note and waiting 20 s;
  - (f) Glass Ocean;
  - (g) Grand Piano.

  Use the same method as reviews/idle-cpu-mac.md (renderer + GPU cputime, per-thread audio / reverb-bg). Report
  `IDLE_CPU_MAC2 a=<r>/<g> b=<r>/<g> b2=<r> f=<r> g=<r> reverbBg_b=<pts>`. Expected: (b) and (b′) near (f)/(g) and
  reverb-bg ≈ 0 in (b), against 35.1 % and 8.5 reverb-bg points before.
- `tools/idle-cpu.mjs` (new, in your `tools/`, written by the cloud profiler) runs the same configurations in
  headless Chromium. Its per-thread numbers are Linux-only (/proc), but its CDP and page counters work on the Mac
  too.
- **R4 (yours):** send `windowHidden` / `windowShown` over `rig:menu` from the BrowserWindow hide/show/minimize paths
  (menubar-B asked for this too). Then re-check on an **unlocked** screen whether rAF keeps running in a hidden or
  minimized window with `backgroundThrottling: false`. Report `HIDDEN_RAF hidden=<rAF/s> minimized=<rAF/s>`.

## security (C6 critics, 2026-09-28; details in reviews/security.md)
- **S1 (major, CONFIRMED; needs Ryan's OK for the outward steps).** Six Apple GarageBand/Logic `.exs` files
  (`tools/exs/fixtures/real/`) are publicly downloadable from `ryanmye/worship-rig`. `raw.githubusercontent.com/…/main/
  tools/exs/fixtures/real/Grand%20Piano.exs` returns 200, and its sha1 matches the local file. docs/garageband-import.md:23
  says to delete that folder before publishing.
  - Now: `git rm -r --cached tools/exs/fixtures/real`, add the folder to `.gitignore`, and keep the files outside the
    repo, e.g. `~/Music/Worship Rig/exs-fixtures`. Let `test/unit/exs/real-files.test.mjs` read `RIG_EXS_FIXTURES`;
    it already skips when the files are absent.
  - Ask Ryan: purge the history (`git filter-repo --path tools/exs/fixtures/real --invert-paths` + force-push main
    and menubar-local) or make the repo private.
  - Report `S1_LOCAL removed=<y/n> history=<purged|private|pending-ryan>`.
- **S4 (server.js).** Drop `roots` from the `/api/user-samples/manifest.json` response; the engine doesn't use it.
  Add `X-Content-Type-Options: nosniff` to `sendJSON` / `sendText`. Optional, Electron only: a per-launch secret
  header (main.js `session.webRequest.onBeforeSendHeaders` for our origin) that the server requires on
  `/api/user-samples*`, `/api/pads`, `/user-samples/`, `/pads/`. Today any local process can list and download every
  My Samples/pad file (measured).
- **S5 (server.js `rewriteUserInstrument`).** Accept `ext` / `format` / `layer.ext` only when they match
  `/^[a-z0-9]{1,5}$/i`, and `notes[]` entries only when they match `/^[A-G][#b]?-?\d$/` or are MIDI integers. Measured:
  `"ext":"wav/../../../../api/heartbeat#"` makes the app request `/user-samples/api/heartbeat`.
- **S6 (main.js).**
  - `rig:streamOpen`: force a `.wav` extension for both bare and absolute names. Today any extension can be created
    in Recordings.
  - `rig:revealFile`: allow only paths under recordings, backups or the user-samples roots. Today it is an existence
    oracle for any path.
  - menubar-local: consider a reduced preload for mini.html (it doesn't need streamOpen/backupNow/…).
- **S7 (tools).**
  - `sample-index.mjs:147`: trust a `.exs` file's stored absolute sample path only under the known sample roots, with
    an audio extension.
  - `import-garageband.mjs`: refuse an `--out` inside `<repo>/app`.
- **S8 (build-lint).**
  - Asar checks: fail on any manifest entry with `"license":"personal-use"`, any `.exs` / `.caf` / `.aif` file, or an
    `app/samples/*` dir not listed in `app/samples/manifest.json`.
  - Repo check (`git ls-files`): fail on `*.exs`, `*.caf`, `user-samples/**`, or a tracked manifest with
    `personal-use` (the synthetic `tools/exs/fixtures/*.json` are allowed).
- **S9 (FYI, for Ryan).** The public `.cloud-outbox/status.md` line 3 names the second GitHub account tied to the Mac's
  SSH key. Reword it if that link shouldn't be public.

## onboarding critic (2026-09-29)
- **README (LOCAL-owned) fixes from `reviews/onboarding.md` R1–R6.**
  - The S items: the vocabulary table (README term → app label, R3), and removing two claims that don't hold:
    - "Files it can't read are listed so you can set their key by hand". There is no such control; say "rename the
      file so its name contains the key".
    - "Chrome needs one click on the page before it will make sound". Through `Start Worship Rig.command` it
      doesn't: the launcher passes `--autoplay-policy=no-user-gesture-required`.
  - The M items: a volunteer-first section ("double-click Worship Rig in Applications"), "your first five minutes",
    Perform at a glance (one annotated screenshot from the Mac), a Quick section, and "make your own song"
    (Edit › + New, click the title to rename, changes save themselves, ⋯ Song › Reset to factory).
- **FYI for your hardware pass with Ryan:** hold-to-unlock Perform lock re-locks if the hold lasts longer than about
  1.2 s (onboarding O1; the cloud fixes `holdButton.js`). Until the drop lands, hold for about 0.8 s, or use Enter.

## L-14 (cloud small-fixes task C, 2026-09-28)
- **Gap:** hide-on-close (docs/menubar-mode.md, COORDINATION L14) had no test on the cloud side. `main.js` has no
  hide-on-close yet, and its `close` handler returns early under `RIG_SELFTEST` (main.js `win.on('close')`), so
  `window.close()` in the self-test would just quit the app. `main.js` and `preload.js` are LOCAL-owned; the cloud
  test is in `test/phase1/shell/electron.boot.mjs` ("L-14: window.close hides…") and the page step `hideOnClose` in
  `test/phase1/shell/fixtures/app/electron-selftest.js`. It skips with a clear message until these exist.
- **Hook 1: `rig.getMenuBarState()`** (preload `rig:getMenuBarState`, already in the docs/menubar-mode.md preload list;
  the renderer calls it in views/settings.js). Payload must include, besides the tray fields:
  `{ menuBarMode: boolean, windowVisible: boolean, windowDestroyed: boolean }` (`windowVisible` = `win.isVisible()`,
  `windowDestroyed` = `!win || win.isDestroyed()`).
- **Hook 2: `rig.setMenuBarMode(on:boolean)`** → `{ok:true}`; main mirrors it to a `menuBarMode` variable.
- **Behaviour under `RIG_SELFTEST=1`:** when `menuBarMode` is true, `win.on('close')` must NOT take the SELFTEST early
  return. It must `e.preventDefault(); win.hide();` and send `windowHidden` over `rig:menu` (and `windowShown` on
  show/restore). With `menuBarMode` false the existing SELFTEST bypass stays as is.
- Expected in the report: `steps.hideOnClose = {before:{windowVisible:true}, after:{windowVisible:false,
  windowDestroyed:false}, ids:[…'windowHidden'…], alive:true}`. The selftest then finishes as usual (the poll's
  `executeJavaScript` works on a hidden window).


## performance profiler (C6 critics, 2026-09-29; reviews/performance.md)
- **New file in your `tools/`: `tools/profile.mjs`**, written by the cloud profiler (read-only against the app). Please
  commit it as-is. For each factory song it runs a 20 s `controller.perform` loop (chords, melody, sustain, a 30 Hz
  wheel sweep) and records: per-call noteOn / wheel cost; event-loop lag; long tasks + long-animation-frame
  attribution; CDP metrics and a sampling profile (self time + callers); DOM / listener / heap counters. Then it
  runs 10 switches, each followed by 10 s of playing.
- **PROFILE_MAC:** on the Mac from source, run `node tools/profile.mjs --json ~/Desktop/profile-mac.json`. It takes
  about 15 min, and port 0 means no fixed port. It has no /proc per-thread CPU off Linux; everything else works.
  Report `PROFILE_MAC noteOnP95max=<song:ms> chordMax=<song:ms> lagP95max=<song:ms> layoutMsPerS=<min–max>
  switch4(organ-swell) lagMax=<ms> fetchesWhilePlaying=<n>` and attach the JSON. The Linux 2-CPU box inflates lag
  whenever the audio thread is busy; the Mac numbers decide how urgent findings 1, 4 and 5 are.
- **Soak (your 30-min run):** please add the renderer's `phys_footprint` (or RSS) per row. On Linux the renderer grew
  1469 → 1482 → 1607 MB over three 19-song laps while the decoded cache (≈ 650 MB) and the heap (≈ 11 MB) stayed
  flat (finding 6). Growth that doesn't level off over 30 min is a native leak. Report
  `SOAK_RSS start=<MB> 10min=<MB> 20min=<MB> 30min=<MB>`.
- **Hardware check with Ryan (optional):**
  1. Switch to Upright Pad and play at once for 10 s: do notes feel late in the first ~10 s (the neighbour
     warm-up decodes 443 samples then)?
  2. Sweep the mod wheel on Synthwave (macro.wash): any hitch the first time the Space size crosses a bucket?
  Report `FEEL upright=<ok|late> synthwave=<ok|hitch>`.
