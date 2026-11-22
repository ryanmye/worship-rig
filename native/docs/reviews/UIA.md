# UIA (16 slots in the UI and the store): skeptic review

Tree: `v2-native` at `b6d7449` (UIA built, committed by the orchestrator's checkpoints) plus this review's edits.
Base for comparisons: `47aa596` (wave-3 integration), extracted with `git archive` into the scratchpad. Own build
dirs `native/core/build-uisk`, `build-uisk-clang20`, `build-uisk-asan` (`-j2`, one at a time). Playwright on a
scratch `PLAYWRIGHT_BROWSERS_PATH` mapping Chromium / headless shell 1194 → the installed 1243 (nothing installed).
The box was shared the whole time with the core-fix skeptic (ctest + goldens) and UIB (ui-core devhost run).

## Verdict

**PARTIAL.** Items 1 and 2 are done, tested meaningfully and hold under the gate; two defects were found and fixed
here (F1 the schema-1 migration re-backed-up the library on every launch and pruned other backups, F2 Sound 5–16
colours ignored Ember's and Nave's role colours). Item 3 is done in the store, controller, scenes and wheel targets,
but MIDI-learn of slots 5–16 has no UI: Settings' Learn table (UIB's file) still lists the 1.x rows, so a user cannot
start learning Sound 5–16 (O1). The bridge path for 16 slots is right in the controller and the shim, but the
JS stand-in for native (`mock-native.js`) still rejects `slots.4..15` (O2).

## Gate, measured here

| check | result |
|---|---|
| ctest g++ 13 Release (`build-uisk`) | 80/80, 0 warnings |
| ctest clang++-20 Release `-Werror` (`build-uisk-clang20`) | 80/80, 0 warnings |
| ctest g++ ASan+UBSan (`build-uisk-asan`) | GATE_ASAN |
| fixtures (`rig_render` all 112, `compare.mjs`) | 112/112 at the manifest tier |
| `parity.mjs --twin <clang renders>` | exit 0; 110 at the exact tier; silent goldens reverb-dry, echo-none; no unexpected failure |
| g++ vs clang++-20 renders | byte-identical, 112/112 (`cmp`) |
| renders vs the wave-3 integrator's (`build-w2/golden-out`) | byte-identical, 112/112: no fixture moved |
| `node --test test/unit/engine-bridge/*.test.mjs` | 118 pass / 0 fail / 2 skip |
| `node test/run-all.mjs --fast` | GATE_RUNALL |
| `test/phase2/ui-core/slots.mjs` alone (with the new F2 test) | 7/7, zero console errors |
| `test/phase2/edit-v2/panels/slots.test.mjs` alone | 4/4 |
| `test/phase1/shell/uia-slots.test.mjs` (with the new F1 test) | 14/14 |

No native file, nothing under `app/js/engine` and nothing under `app/js/engine-bridge` changed in UIA (`git diff
47aa596 --stat`; the engine-bridge rows in that diff are UIB's).

## Claims checked

- **Byte-for-byte migration.** A differential run of the 47aa596 store against this one over 3,000 random schema-1
  / schema-less libraries (factory songs, 0–17 slots, nulls, wheel targets on slots 0–7 and junk, scenes of 2–6
  entries, missing patches), the 1.x fixture and every factory song: 3,020 cases, 0 differences other than the
  `schema` field. Idempotence and unknown fields are covered by the builder's tests and hold.
- **Fixture provenance.** `test/phase1/shell/fixtures/uia/library-1x.json` is a fixed point of the 47aa596
  `migrate()` except `settings` (checked with the extracted store: all 19 songs, setlists and orders unchanged; the
  settings differ only by the device-local keys an export leaves out), so it is a genuine 1.x export.
- **Web engine never sees slots ≥ 4.** `call('setParam')` drops them, `prepare` / `preload` / `estimatePreloadMB` /
  `retainReverb` / `setRouting` get `enginePatch()` (first 4 slots, a wheel target past them → `'none'`), meters
  return null past `engineSlots()`; a 4-slot patch is passed through as the same object. Tested in
  `uia-slots.test.mjs` and ui-core `slots.mjs` (the engine's setParam log has no `slots.4+`).
- **Bridge gets 16.** End to end here with the real `BridgeEngine` over a loopback to `MockNative`: `engineSlots()`
  16, `prepare` carries 16 slots, `set slots.12.gain` is sent, routing carries `slots.12.gain`. The mock then answers
  `unknown-param` (O2). The native core takes `slots.0..15` (`params.cpp`, `song.cpp validTarget`).
- **4-slot layout unchanged.** Before / after 4-slot Perform shots differ only in the master meter (1440) and not at
  all (820). Edit differs by the "Slots 4" button only (the rig bar's right group shifts left by its width).
- **Real-time safety.** No core change. Hidden and scrolled-off strips' meters stop reading (`levelMeter` uses an
  IntersectionObserver); strips past the count are built once and kept hidden; nothing new runs per audio block.

## Fixed here

- **F1 (store, medium): an unedited schema-1 library was backed up on every launch.** The migrated state was only
  written at the first edit, so storage stayed schema 1, every launch saw `schema < SCHEMA` again, wrote another
  `rig.v1.backup-<ts>` and pruned to `BACKUPS_KEEP` (3): by the third launch an older backup of another kind (a
  corrupt or future-schema library kept by `backupRaw`) was deleted. Measured with a 5-launch script: backups
  `[1, 1100]` → `[1100, 2100, 3100]` → … , storage schema 1 throughout. Fix (`app/js/store.js`, end of
  `createStore`): once the copy is written (`info.migrationBackupKey`) the library is saved back as schema 2
  (`schedulePersist()`); without a copy nothing changes (as before). After: one copy, older backups kept, storage
  schema 2 from the first launch. Test: `uia-slots.test.mjs` "an unedited 1.x library is saved as schema 2 at load".
- **F2 (styles, low): Sound 5–16 used Classic's colours under Ember and Nave.** `--slot-4..15` were declared on
  `:root` only; their `var(--slot-0..3)` resolve where they are declared, and Ember / Nave set the role colours on
  `body`, so the mixes were Classic's (Ember: Sound 5 `oklch(.772 .174 102)` vs its own mix `oklch(.780 .107 91)`).
  Fix (`app/styles.css`): the declarations move to a `:root, body` rule. Probed in Chromium for classic, ember, nave,
  studio, daylight-day: every Sound 5 now equals its theme's mix. Test: ui-core `slots.mjs` "Sound 5..16 colours mix
  the theme’s own role colours" (switches to Ember and back).
- `CONTRACT_CHANGES.md` "## UIA": both fixes noted.

## Open

- **O1 (item 3, UI): Settings cannot learn Sound 5–16.** `app/js/views/settings.js` (UIB) builds `LEARN_ROWS` from
  the 1.x `LEARNABLE`. The builder's suggested diff is right: rows from `learnTargets(MAX_SLOTS)` (or the current
  song's count), and `LEARN_NAMES[id] || (slotGainIndex(id) !== null ? \`${slotName(slotGainIndex(id))} level\` :
  id)`. Until then item 3 is reachable only through `controller.learn('slots.<i>.gain')`.
- **O2 (engine-bridge, orchestrator / UIB): `mock-native.js` rejects `slots.4..15`.** `op_set` / `param` use
  `isValidPath(path)` (default bound 4) while the core takes 16 since T00c. Any mock-backed run of a song with more
  than 4 slots warns `Unknown parameter "slots.N…"`. One-line fix: `isValidPath(path, MAX_SLOTS)` (params.js now
  takes the bound).
- **O3 (docs, orchestrator):** `CLAUDE.md` still says `SCHEMA = 1` and "7 block tabs (Keys · Pad · Extra · Bass ·
  Drone | Effects · Master)"; `shared/hotkeys.js:212` comment says "schema stays 1".
- **O4 (builder's item 4):** with a slot count other than 4 the wiring strip's columns no longer line up under the
  (scrolling) tab row. Cosmetic.
- **O5:** no browser run of the app on the bridge engine with more than 4 slots (the app cannot run the bridge in a
  browser; the devhost harness could, once O2 is fixed).
- **O6 (pre-existing):** Edit at 820×1180 overflows sideways before and after UIA (REC timer, Notes and "Wheels &
  pedal" clipped); the "Slots n" button pushes the rig bar's right group a further ~70 px off screen there.
