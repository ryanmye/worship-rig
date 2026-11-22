# CORE2B (tick pedal / held / swelling, contracted `get param`): skeptic review, 2026-11-22

Verdict: **VERIFIED** (one small correction made here). All three defects (PARITY "UI parity" rows 2-4: pedal lamp,
`swelling`, param read-back) are fixed, each has a test, and the C++ tests fail on the base behaviour (mutation runs
below). The raw ui-core count on `rig-devhost` is **77/77 in both of this review's runs**, as the builder reported.
No fixture moved. The changed code is real-time safe. One builder open item was wrong in the builder's disfavour
(pedalHold, below) and the shim's patch fallback disagreed with the core on it; fixed here.

Tree: `v2-native` at `882e530` ("CORE2A+B built") and the orchestrator's later review checkpoints (only CORE2A's
`test_runtime_preload.cpp`, its review and one INTERFACE_LOG line changed after it), plus this review's edits. Own
build dirs (fresh, real directories, `-j2` at most): `native/core/build-c2bsk` (g++ 13 Release),
`build-c2bsk-clang20` (clang++-20 Release, `-Werror`), `build-c2bsk-asan` (g++ RelWithDebInfo,
`RIG_SANITIZE=address;undefined`), `build-c2bsk-tsan` (g++, `RIG_SANITIZE=thread`), `native/devhost/build-c2bsk`
(g++ Release). Mutation builds in a scratch copy of `native/core` (Debug). Playwright through the existing
1194 -> 1243 mapping (`scratchpad/uisk/pw`); nothing installed.

## Gate, measured here

| check | result |
|---|---|
| ctest g++ 13 Release | **82/82** (`-j2`), 0 warnings |
| ctest clang++-20 Release `-Werror` | **82/82** (`-j1`, next to another lane's ui-core run), 0 warnings |
| ctest g++ ASan+UBSan | ASAN_RESULT |
| TSan | TSAN_RESULT |
| fixtures (`rig_render`, all 112, `compare.mjs`) | **112/112** |
| g++ vs clang-20 renders | byte-identical, 112/112 (`cmp`) |
| vs the UIC skeptic's g++ renders (`scratchpad/uicsk/r-gcc`, before CORE2A / CORE2B) | byte-identical, 112/112: no fixture moved |
| `parity.mjs --twin <clang-20>` | exit 0; 110 at the exact tier; "unexpected failures: none" |
| `build-engine-api.mjs --check` | `engine-api.json` is up to date |
| `node --test test/unit/engine-bridge/*.test.mjs`, `RIG_DEVHOST` = this review's devhost | **131 / 0 / 0** (the `get-param` devhost case ran) |
| ui-core on `rig-devhost`, `--no-adapter` (raw) | **77/77, 77/77** (the second run next to this review's ASan build); no bridge error reply; the two known warns; `sanitizer: (none)`; "no console errors on the main page" passes |
| Settings `SETTINGS_MODES=bridge` | **9/9**, zero console.error |

## Items

- **Row 2, pedal lamp (UIC S1): done, tested, real-time safe.** `Engine::buildTick` (control thread) reads
  `Perform::pedal()` / `held().size()`; `Graph::setPerformMeters` packs both into one relaxed `atomic<uint32_t>` that
  the control loop writes once per pass (and `renderOne` before each offline quantum) and the snapshot fill reads once
  per quantum: no lock, no allocation, no wait on the audio thread. `held` = held physical keys, which is what the
  contract's `notes {held}` and tick `held:n` mean. Mutation runs (scratch copy, `-ts=core2b`):
  - base behaviour (snapshot fill removed, tick from the snapshot, tick `runtime` without `swelling`): 4 of 7 cases
    fail (52 assertions): the 0.2-1.6 s pedal checks, the V1 `rig_meters` case, the swelling case and the realtime
    case (`lit == ticks`);
  - only the snapshot fill removed: exactly the `rig_meters` checks fail (2 cases), the tick checks pass, so the
    meters test is independent of the tick fix.
- **Row 3, tick `swelling`: done, tested.** `tickRuntimeJson` = `runtimeStateJson` + `swelling` (same
  `swellActive_` rule as `wheelValuesJson`); `get state` keeps its shape (checked). Fails on the base behaviour above.
- **Row 4, contracted read-back: done, tested.** `get {what:'param', path}` (schema variant makes `path` required:
  `bad-request`; outside the grammar: `unknown-param`), `readParam` over the Model's patch, which `Model::set` updates
  at call time also for a `{when}` set (`storeRow` before the handler), so a `get` behind a set always sees it.
  Checked against audio.js `getParam` + `normalizePatch`: slot rows, `width`, `fx.eq.*` / `fx.comp.amount` (web
  defaultPatch has them), EQ b-rows resolved, legacy rows stored-or-default, instrument params stored-or-catalogue
  default (organ `rotary` is the only enum param of any instrument, `instEnumIndex`), `drone.*` live. The shim mirror
  (`getParam`) is sound: per-path generation + commit epoch drop an answer a later write overtook, one request per
  path and write, `_req` flushes pending `set`s first. The UI itself never calls `getParam` (only `__t.param` in the
  ui-core suite), so the mirror is a test-facing read; the devhost node case checks the entries become
  `confirmed: true` with the core's clamped values. Base shim / mock have no `getParam` / `get param`, so the JS tests
  cannot pass there.
- **Contract: consistent.** `hello` minor 5 + `getParam` in bridge.cpp, mock, `test_t00c`, `unit.core2b`,
  ENGINE_CONTRACT 6.2; `get` row in spec / JSON / README / ENGINE_CONTRACT 6.4; method count 69; INTERFACE_LOG
  CORE2B-1..9 match the markers (`graph.h` x2, `graph.cpp`, `bridge.cpp` x4, `schema.cpp` x2, `test_t00c.cpp`). CORE2A
  logged no contract change of its own (INTERFACE_LOG "## CORE2A"), so minor 5 covering only CORE2B's op is right.

## Found here

- **C1 (fixed): builder open item 1 was wrong, and the shim's fallback disagreed with the core.** The builder wrote
  that the web engine returns undefined for an absent `pedalHold`. It does not: audio.js `normalizePatch` stores
  `clampParam('slots.<i>.pedalHold', undefined)` = `'natural'`, so `getParam` reads `'natural'`, exactly what the
  core answers. But `param-read.js` `patchParam` (the shim's answer before the core's arrives, and the mock core's
  answer) returned undefined for every absent optional row. Fixed: an absent optional row reads its PARAMS default
  (`'natural'` for pedalHold, undefined for release); a stored `null` reads as absent. New assertion in
  `get-param.test.mjs`. Also fixed a stale reference (`_paramNow`) in its header comment.

## Open (nits, none blocking)

- **N1**: an absent `release` reads `null` on the web engine (`normalizePatch` stores null) and `undefined` on the
  bridge (core: value absent; contract text: "undefined for an unset optional row"). No caller reads it today.
- **N2**: a path the shim thinks is valid but the core refuses (`unknown-param`) is never cached, so every read
  re-sends `get param` (the warn is once). No such path exists today (both use the 16-slot grammar).
- **N3**: `readParam` re-parses the whole instrument catalogue JSON for every `slots.<i>.params.*` read (control
  thread, once per read request; fine at test rates).
- **N4**: `rig_test_query("getParam:...")` reads the Model on the caller's thread; in realtime mode that races the
  control thread, like the existing `getState` hook. Test-only.
- Builder open item 2 (instrument params read back as the core stores them, clamped) stands.
- Build dirs: this review's are deleted; prune the builder's if any are left.
