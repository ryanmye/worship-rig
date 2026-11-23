# MACFIX (Mac check #3: `unit.synth` / `unit.synth-extra` fail on the Mac): skeptic review, 2026-11-22

Verdict: **VERIFIED**. One test gap is closed here (S1). The builder's root cause is right: the failures come from
test order, not from the linker. Nothing in `native/core` registers from a static initializer, the real app was never
affected, both Mac failures reproduce on Linux, and the 70-vs-82 count is fully explained by the 12 `golden.*` tests.

Tree: `b9a0c27` plus the MACFIX files only (`src/inst/synth_dispatch.{h,cpp}`, `tests/test_synth.cpp`,
`tests/test_registry_link.cpp`, `tools/mac/check.sh`) and this review's `tests/test_synth_extra.cpp` case. It is a
copy of the working tree with every CORE3 file reset to `b9a0c27` (checked file by file with `cmp` against
`git show b9a0c27:`), so CORE3's uncommitted work is left out. Own build dirs, fresh, real directories, deleted at the
end: `native/core/build-macfix` (g++ 13 Release), `build-macfix-clang20` (clang++-20 Release, `-Werror`),
`build-macfix-asan` (g++ RelWithDebInfo, `RIG_SANITIZE=address;undefined`, `-fno-sanitize-recover=all`),
`build-macfix-lld` (clang-20, tests off, `-ffunction-sections -fdata-sections`). `-j2` while CORE3 was idle, `-j1` once
it was building.

## Gate, measured here

| check | result |
|---|---|
| ctest g++ 13 Release | **83/83**, 0 warnings |
| ctest clang++-20 Release `-Werror` | **83/83**, 0 warnings |
| ctest g++ ASan+UBSan | **83/83** (`-j1`), 0 warnings, no sanitizer report in `LastTest.log` |
| Mac-like run (g++, `native/golden/out` moved away, `ctest -LE "devhost|golden"`) | **71/71** |
| fixtures (`rig_render`, all 112) + `parity.mjs --twin <clang-20>` | exit 0; **112/112** at the manifest tier, 110 at the exact tier, "unexpected failures: none" |
| g++ vs clang-20 renders | byte-identical, 112/112 |
| vs `build-int/golden-out` (the integrator's renders) | byte-identical, 112/112: no fixture moved |

83 = 82 + `unit.registry-link`. The devhost tree (88/88 in the builder's report) was not rebuilt here. Its suites carry
the same labels, and `check.sh` runs `-LE devhost`.

## Root cause: confirmed

- **Reproduced on Linux with the old binary.** On `build-int` (built before MACFIX):
  - `./rig_tests -ts=synth-extra -tc='inst.synth dispatch*'` fails `test_synth_extra.cpp:86`, `REQUIRE(nullptr != nullptr)`.
  - `-ts=synth -tc='synth-extra ids*'` fails `test_synth.cpp:260` and `:261`.

  These are the same lines and the same assertions as on the Mac.
- **Why only the Mac.** Each ctest is its own process (`rig_tests -ts=<suite>`), and registration happens at the first
  `rig_create` (`Engine::create` -> `ensureModulesRegistered()`, `std::call_once`).
  - `unit.synth-extra`: the only case before line 86 that creates an engine is the golden case, and it `continue`s
    when `!g.present`.
  - `unit.synth`: before line 251 the same holds. The other cases use `t11::Driver`, not an engine.

  `native/golden/out` is git-ignored, so it is never in check.sh's export.
- **The linker, checked here.**
  - Build: core built dead-strip style (`build-macfix-lld`); `librig_core.a` and `librig_third_party.a` merged
    into one archive (`ar -M`, like `libtool -static` in `build-core.sh`).
  - Program: a C program that uses only `rig_engine.h` (what `RigHost.swift` reaches), linked with
    `clang++-20 -fuse-ld=lld -Wl,--gc-sections`.
  - Result: 748 sections removed, none of them a `rig_register_*`. All 17 register functions are kept, and so are
    `registerSynthExtra` and `makeSynthExtraUnit`. The program plays `supersaw-pad`, `juno-pad`, `pluck`, `808-sub`,
    `warm-pad` and `organ-gospel` with no `unsupported` (RMS 0.012-0.115).

  This is expected. ld64, like ld.lld, loads an archive member only to resolve an undefined symbol, and `-dead_strip`
  keeps whatever is reachable. `rig_create` -> `Engine::create` -> `ensureModulesRegistered()` names every
  `rig_register_*` through the generated `rig_modules.inc`. `build-core.sh` builds `rig_core` with this same
  CMakeLists, so the Apple slices use the same `rig_modules.inc`.

## Every hook: confirmed

- **Static initializers.**
  - `nm librig_core.a` has `_GLOBAL__sub_I_*` in six objects only: `lofi`, `meter`, `rec`, `sampler_service`,
    `synth_dsp` and `synth_extra_dsp`. In each the initializer is a namespace-scope `std::map` or `std::vector`
    cache next to a `std::mutex`, and none of them registers anything.
  - `librig_third_party.a` has none.
  - There are no `__attribute__((constructor))`, `[[gnu::used]]` or registrar objects.
- **Function-local static with a side effect.** The only one is `oscFinalValueCalls()` in `synth_voice.cpp`, a
  measurement with no registration.
- **Mutable hooks.** `g_extra` in `synth_dispatch.cpp` is the only global function pointer. Organ and drone register
  through the registry.
- **Registration path.** All 17 `src/**/*_register.cpp` files only define and `add*` factories. None calls a factory,
  `makeSynth` or the hook, so the `std::call_once` reentrancy deadlock the header warns about cannot happen.
- **Test-only registration.** `tests/test_modules_init.cpp` has the static registrar for the test modules. It is in
  the test executable, not the archive, so it is always linked.

## Fix: sound

- **MACFIX-1** makes the result independent of whether an engine was created first.
  - After the first call, `call_once` takes the fast path: an acquire load, no lock. So the extra call at each
    commit (`instrument_service.cpp:104`) and in `makeSynth` costs nothing that matters.
  - The CORE3 build worker can call `makeSynth` on its own thread. That thread starts after `rig_create`, and the
    `call_once` acquire orders the read of `g_extra` after the registration in any case.
- **MACFIX-2** keeps the T15-absent path (silent output plus the `unsupported` warning) reachable in any test order.
- **Not frozen.** `synth_dispatch` is a T11 module and is not on the BUILD_PLAN "Frozen interfaces" list. No frozen
  file was changed, so the empty INTERFACE-CHANGE list is right.

## Tests: mutation runs (g++ build, the scratch tree restored after each)

| mutation | `unit.registry-link` | `unit.synth-extra` | `unit.synth` |
|---|---|---|---|
| M1: `ensureModulesRegistered()` removed from `Engine::create` | **fails**, 38 assertions (case a). Case b alone (`-tc`) fails 12. | | |
| M2: T15's `registerSynthExtra(...)` line removed | **fails**, 32 assertions, both cases | **fails**, 3 cases | |
| M3: `synth_dispatch.{h,cpp}` back to `b9a0c27`, goldens present | passes (as the builder said) | **fails** at the new S1 case (`:33`) | passes |
| M3, `native/golden/out` absent | passes | **fails** at `:33` and at `:93` (the Mac's `:86`) | passes (MACFIX-2 registers first) |

M1 and M2 match the builder's numbers. In the full suite, case b passes under M1 because case a's closing
`synthExtraFactory()` call has already registered the modules. Case a still catches M1, so this is harmless.

## Items

- **S1 (fixed here): the Linux gate did not catch a revert of MACFIX-1.**
  - The gap: `unit.registry-link` passes under M3 by design. In `unit.synth-extra`, the golden case creates an
    engine before line 86 whenever `native/golden/out` exists, and it always exists on Linux and in CI. So the
    exact Mac failure could come back unseen until the next Mac check.
  - Fix: a new first case in `tests/test_synth_extra.cpp`, "the synth-extra hook is set when read before any engine
    exists" (one `CHECK`). doctest's default `order-by=file` runs it first in its process. It fails under M3 with
    goldens present (table above).
  - No ctest added: the counts stay 83 on Linux and 71 in the Mac-like tree. Logged as MACFIX-5 in
    `INTERFACE_LOG.md`.
- **S2 (doc, fixed here): the Mac count to expect next.** The builder's "expected Mac count is 71/71" holds for
  `b9a0c27` plus MACFIX. `v2-native` now also has CORE3's `unit.core3` (label `unit`), so Mac check #4 should show
  **72**. Added to `MAC_CHECK.md`.
- **N1 (nit, open): the "?" fallback in `check.sh` never fires.** If `ctest -N` fails, `grep -c` still prints `0`,
  so the note reads "0 golden.* tests not run" and the `${ngold:-?}` fallback never fires. Checked here with a
  missing tree dir. The note is informational and the excluded set is still right. Owner: next `check.sh` touch.
- **N2 (nit, open, pre-existing): two small problems around the hook.**
  - `synth_dispatch.cpp:6` says `g_extra` is "written only from rig_register_*". `test_synth` also overrides it.
  - That test restores the hook only on its normal path. A throwing `REQUIRE` inside `commitSlot0` would leave the
    hook overridden for the rest of that one process.
- **Not run here:** a full `tools/mac/check.sh` run (needs a Mac), and the devhost-tree build. I ran the changed
  `ngold` line by hand against `build-macfix`: it gives 12, and `bash -n` passes.
