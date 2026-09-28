# Worship Rig architecture (as built)

This is a short map of how the pieces fit. `SPEC.md` has the original contract and `CONTRACT_CHANGES.md` has every
change since, with measurements. Where this page and the code disagree, the code wins. Please fix this page when
that happens.

## Processes

```
Mac app (Electron)                                   Chrome fallback
┌──────────────────────────────┐                     ┌──────────────────────────────┐
│ main.js (main process)       │                     │ serve.mjs (node)             │
│  • server.js on 127.0.0.1:8438│                     │  • server.js on 127.0.0.1:8437│
│  • window, menu, permissions │                     │  • opens Chrome --app=…      │
│  • IPC: recording streams,   │                     └──────────────┬───────────────┘
│    pads, backups, My Samples │                                    │ HTTP
└──────────────┬───────────────┘                                    │
               │ preload.js → window.rig                            │
┌──────────────▼────────────────────────────────────────────────────▼──────────────┐
│ renderer: app/index.html → app/js/main.js (plain ES modules, no build step)        │
└────────────────────────────────────────────────────────────────────────────────────┘
```

- **server.js** is shared by both. It serves `app/` with correct MIME types and HTTP Range support, and adds a few
  routes:
  - `/api/health` and `/api/heartbeat` (so the launcher doesn't open a second window).
  - `/api/pads` and `/pads/<token>/…` for the user's pad folder.
  - `/api/user-samples/manifest.json` and `/user-samples/<token>/<pack>/…` for "My Samples".
  - `/api/user-samples` (a summary for Settings) and `/docs/<name>.md`.

  It binds to 127.0.0.1 only and checks the Host header. File routes realpath-check that a file stays inside its
  folder.
- The page's **origin** (`http://127.0.0.1:<port>`) is also where localStorage lives, so the port is fixed on purpose.
  Electron always runs its own server. If 8438 is busy it takes the next port and offers the newest disk backup.
- There is **one playing window** at a time. Electron uses the app's single-instance lock, and every page takes the Web
  Lock `rig-instance`. A second window is read-only and muted.

## Renderer layers

```
views (perform.js, edit/ (H-v2 Edit), settings.js, components/)
   │  store.set(...) for anything persisted        controller.* for actions (next song, panic, record, learn…)
   ▼                                                 ▼
store.js ──── subscribe(state, changedPaths) ────► controller.js ────► engine (app/js/engine/index.js)
   ▲                                                 │  ▲
presets.js (factory songs)                  midi.js ─┘  └─ recorder.js (AudioWorklet on engine.recordTap)
shared/ (params grammar, fx-presets, music, automation, keydetect, chords, wav, prng): pure, no DOM/audio
```

- **store.js** holds the whole library: songs, setlists, settings and meta. It persists to localStorage with debouncing,
  retries and backups, and every write is validated against the parameter table in `shared/params.js`. Songs are
  immutable (frozen). `set(path, value)` returns canonical changed paths to subscribers.
- **controller.js** is the only module that talks to both store and engine:
  - song selection: prepare, then commit, then transpose, routing, drone and tempo, then preload the neighbours;
  - decoded-sample memory: which songs stay pinned in the engine's sample cache (no setlist: the current song and its
    library neighbours; a setlist: all of it, or the current ±2 when it would decode to more than 600 MB), see
    CONTRACT_CHANGES "morning-prep";
  - store→engine diffs for the current song;
  - MIDI, computer-keyboard and on-screen input (refcounted notes, sustain, pedal polarity, learned controls with
    pickup);
  - the audio watchdog and restarts, the wake lock, Electron menu actions, backups and the My Samples rescan.
- **Parameter grammar** (`shared/params.js`): examples are `slots.1.gain`, `slots.0.params.tone`,
  `fx.reverb.size`, `master.volume` and `drone.gain`. The PARAMS table is the single source for ranges and
  defaults. The store, controller, UI and engine all read it, so adding a row there makes a param flow end to end.

## Views

- **main.js** owns the top bar, view switching (`setView(name, {block, focus})`), the Settings modal, toasts
  (`toast(msg, kind, {ms, action})`) and the start overlay. It mounts `perform.js`, `edit/shell.js` and `settings.js`
  with one ctx; `ctx.getBaseline()` returns Perform's Revert snapshot so Edit's changed dots count against it.
- **Perform** (`views/perform.js`) is the playing surface (H-v2 perform.png): strips of `components/` pieces
  (`onTile`, `stepChip`, `fader`, `holdButton`, …).
- **Edit** (`views/edit/`, H-v2 edit.png; the contract is `views/edit/CONTRACT.md`):
  ```
  edit/shell.js   mountEdit(el, ctx): layout (setlist | song header over the rig card | keyboard row), 7 block tabs
                  (Keys · Pad · Extra · Bass · Drone | Effects · Master), Show wiring, EditState (selection,
                  baseline, changes), a per-panel ctx (store fan-out, Esc stack, song-bound fields, cleanup)
  edit/lib.js     shared helpers: h, icon/iconButton, sentence, createBinder, section, wordSlider, BLOCKS, labels
  edit/panels/    one module per block/region: slot (Keys/Pad/Extra/Bass, incl. Advanced › Tone = the keyboard EQ),
                  drone, effects, master (incl. Wheels & pedal), song (+ song-header), setlist, bottom
  edit/base.css + panels/*.css, pulled in by edit/styles-edit-v2.css (base first, so panel rules win ties)
  ```
  A panel reads and writes only through its ctx (`ctx.set`, `ctx.subscribe`, `controller.*`), never the engine.
  The slot EQ editor is `components/eq-keyboard.js` (`eqKeyboard`, `eqMiniCurve`) over `shared/eq-math.js`.
- **Settings** (`views/settings.js`, styles in `styles-edit.css` `.st-*`) is a modal over either view.

## Engine

- **AudioEngine** (`engine/audio.js`) has a two-phase song switch. `prepare(patch)` does all the expensive work:
  building instruments, decoding samples and reverb impulse responses (IRs), which run in a Worker. It resolves a
  token. `commit(token, {when})` only changes gains and connections. Held and pedalled notes keep sounding on the old
  instruments (the "MainStage" switch). Old channels are retired and disposed after 1 s without voices, timed on the
  audio clock. Only the latest token can commit.
- Every time-sensitive call takes `{when}`, and no timers are used (`AudioTimer`). The same graph therefore renders
  deterministically into an OfflineAudioContext. The tests, `tools/calibrate.mjs` and `tools/audition.mjs` rely on this.
- **Signal path** (`engine/fx.js`):
  ```
  slot: instrument → trim → strip (width/EQ, fader × wheel, pan) ─┬─ dry ─────────────────────────────┐
                                                                  ├─ send → reverb (pooled IR units) ─┤
                                                                  ├─ send → delay (2 lines, sync)  ───┤→ sum → lofi (bypassed at 0)
                                                                  └─ send → chorus ───────────────────┘   → master EQ → glue comp
  drone (synth or files) ─────────────────────────────────────────────────────────────────────────────┘   → master → wheel → fade
                                                                  → [mono sum] → catcher comp → soft clip → out + recordTap
  ```
- **Instruments** (`engine/instruments.js` registry):
  - `synth.js` and `synth-extra.js` are subtractive/FM synths; `organ.js` is a drawbar organ with a rotary speaker.
  - `sampler.js` plays the multi-sampled instruments from `app/samples/manifest.json`, plus the optional My Samples
    manifest, whose ids get a `user:` prefix and the group "My Samples".
  - `drone.js` is the key drone. It is either a synth (drone-osc layers) or the user's pad files.
- **Levels:**
  - Sampler trims are `gainTrim` (dB) in the manifest.
  - Synth and organ trims are in `engine/gain-trims.json`, plus `droneTrim`. `synth-extra.js` folds its calibration
    into the patch itself.
  - All of these come from `tools/calibrate.mjs` (SPEC §12, method in CONTRACT_CHANGES "## audition").

## Samples

- **Bundled:** `app/samples/<id>/…` with `manifest.json`. The formats and licenses (Salamander CC BY, VSCO CC0,
  Musyng Kite CC BY-SA) are described in `LICENSES.md`.
- **My Samples** (not bundled): `<repo>/user-samples/` and `~/Music/Worship Rig/Samples/`. `RIG_USER_SAMPLES`
  overrides both. Each sub-folder is a pack with its own `manifest.json` in the same format. The server merges the
  packs and rewrites their sample URLs. The engine loads the result only after `/api/health` reports
  `userSamples: true`, which avoids 404 console errors. `tools/import-garageband.mjs` fills this folder from
  GarageBand/Logic content; see `docs/garageband-import.md`. It is Apple-licensed and **never** committed or packaged:
  `.gitignore` and the electron-builder `files` both exclude `user-samples/`.

## Persistence and files

| what | where |
|---|---|
| library (songs, setlists, settings) | localStorage `rig.v1` of the page origin (+ `rig.v1.backup-*`) |
| Mac app backups | `<userData>/backups/rig-*.json` (newest 10; one on every window close) |
| Mac app shell config (pad folder) | `<userData>/rig-shell.json` |
| recordings | `~/Music/Worship Rig/*.wav` (Mac app streams to disk; Chrome: save dialog / OPFS / download) |
| My Samples | `~/Music/Worship Rig/Samples/<pack>/` and `<repo>/user-samples/<pack>/` |

## Tests

`npm test` runs `test/run-all.mjs` (everything but the soak). The suites are: `unit` (shared modules), `engine`,
`instruments` and `synth-extra` (offline Chromium renders), `shell` (store/controller/midi/presets/server with fakes,
Playwright, Electron boot), `ui-core` (Perform, real app in Chromium), `edit-v2` (the Edit shell, one file per
panel on a test harness, and an integration file on the real app), `settings` (real app + a settings-only fixture),
`eq` (the keyboard EQ component), and `chrome-fallback`, `electron-full`, `build-lint` and `soak` (integration).
Details are in `test/README.md`.
