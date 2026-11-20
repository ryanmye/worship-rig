# D4 core (total voice limit): skeptic review

Reviewer build dirs: `native/core/build-d4core-review` (g++ 13 Release), `-clang` (clang 18 Release), `-asan` (g++
ASan+UBSan, RelWithDebInfo), `-tsan` (g++ TSan, `rig_tests` only). Baseline for the fixture check: `git archive
e3e8d64` (the commit before D4) plus the git-ignored `native/golden/pcm/` overrides, `rig_render` built in the
reviewer's scratch dir. The tree is HEAD `59fb0f0` plus this review's edits.

## Verdict

**VERIFIED**, with one MEDIUM design caveat (R1) written into ARCHITECTURE 7.1. Behaviour matches DECISIONS D4. The
code path on the audio thread allocates nothing, takes no locks and has a bounded loop. Every gate the builder claimed
reproduces. Two small defects were fixed here: a UB on the schema change (R2) and a CPU assertion too weak to check the
budget (R3).

## Gates (measured here)

| config | result |
|---|---|
| g++ Release | 57/57, and 57/57 again on the final tree after the review edits |
| clang Release | 57/57, and 57/57 again on the final tree |
| g++ ASan+UBSan | 56/57: `rt.realtime` hit its xrun limit with `-j2` next to another agent's load and passed when re-run alone (the known flake in REPICKUP). `unit.voice-limit` and `-cpu` passed, no sanitizer report |
| g++ TSan | voice-limit 8/8, bridge 11/11, bridge-conformance 5/5, clock 2/2, offline 11/11, queues 5/5, realtime 7/7, runtime 11/11; 0 ThreadSanitizer warnings |
| fixtures | 108/108 renders byte-identical to the e3e8d64 baseline, so the default limit never engages. `compare.mjs`: 67/108 pass on both trees with the same verdicts |
| `node test/run-all.mjs --only unit` | 510 pass / 0 fail |
| `node --test test/unit/engine-bridge/*.test.mjs` | 111 pass / 0 fail / 2 skipped |
| `build-engine-api.mjs --check` | up to date |

**Fixture-check pitfall.** A baseline from `git archive` alone lacks `native/golden/pcm/`, which is git-ignored. Its
sampler fixtures then fall back to the native MP3 decode and 17 renders differ. Copy the PCM overrides first.

## CPU numbers (re-measured, `unit.voice-limit-cpu`, g++ Release, shared 2-CPU box)

- **Per voice:**
  - warm-pad 9.0 / 9.1 µs, strings 8.7 / 9.95 µs. Strings was the costliest voice in one of the two runs, within the
    builder's spread.
  - glass-pad 6.4, soft-keys 4.7–4.9, bell 4.6–4.8, sub-bass 2.7–3.2 µs.
- **fixed16 depends on the patch:** 87–204 µs. Warm-pad is the highest.
- **Fit:** 148 / 154 voices, so desktop **128** is conservative on this box.
- **Budget case:** 16 warm-pad slots played to 256 note-ons and held at 128 voices take 1304 / 1315 µs (g++) and
  1333 µs (clang), 49–50 % of the quantum. This matches the builder's 47–50 %.
- **iPad 64** is not measured. It assumes a core 2× slower than this box, and the docs say so.

## Findings

| id | severity | finding | change |
|---|---|---|---|
| R1 | MEDIUM (design; documented, not fixed) | The 60 % sizing covers the steady state only. Stolen voices still render their 20 ms steal fade but are not counted, and building a warm-pad voice costs about 20–40 µs per note-on. Scratch probe on this box (warm-pad, 16 slots, limit 128, thread CPU per quantum): a 10-note chord on 16 layered slots (160 note-ons) took **6.0–6.4 ms** in its own quantum, then **2.7–3.0 ms (100–110 %)** for about 8 quanta. At limit 512 (no steals) the same chord took 9.3 ms, then 6 ms. One new key per quantum on 16 slots settled at 3.4–3.9 ms. The limit helps but does not bound a burst. | Added to ARCHITECTURE 7.1 "D4". When the Mac/iPad numbers come in, also time a large layered chord. Options for Ryan/T13: size Auto with fade headroom, i.e. `(0.6·Q − fixed16 − steals₂₀ₘₛ·perVoice) / perVoice`; or count fading voices toward the limit; or cap note-on construction per quantum. None of these is a small change. |
| R2 | LOW, fixed | `schema.cpp` Enum-as-number did `static_cast<long long>(d)` on any finite whole double. `{"voiceLimit":1e300}` from the WebView was UB, and g++'s `-fsanitize=undefined` does not include float-cast-overflow. | Bounded `std::fabs(d) < 1e9` before the cast. `1e300` / `-1e300` added to the bad-value list in `test_voice_limit.cpp`. **schema.cpp is a T08 file:** this is the smallest edit, on a line D4 added. |
| R3 | LOW, fixed | The budget test asserted `us < 2667 µs` (100 % of the quantum). A limit sized twice too large would still pass. | `kBudgetUs = 0.70 × quantum`: the 60 % target plus margin for the shared box, measured 49–50 %. |
| R4 | LOW, open (orchestrator) | `hello.minor` stays 1. T00c set the precedent by bumping 0→1 for its additive caps (`432cd4b`), and the contract README rule says to bump. | `bridge.cpp` opHello `kv("minor", 2)` (comment "D4: config.voiceLimit"). `test_t00c.cpp:210` then checks `"minor":2`, or better checks only that minor ≥ 1. The mock's `MINOR = 0` already lags, as before. |
| R5 | LOW, doc fixed | The claim "converges over a few notes" holds only for layered slots. Each note-on nets −3 (4 steals minus the new voice). One key on 16 layered slots removes 48; one key on a single slot needs about 90 keys to go from 400 to 128. | Wording fixed in ENGINE_CONTRACT, ARCHITECTURE and the `kMaxLimitStealsPerNote` comment. |
| R6 | LOW, open | Auto rounds to the *nearest* multiple of 16: 125 → 128 and 62 → 64. A ceiling should round down, which is why the worst run sits at 61 %. | Either round down when the Mac/iPad numbers replace the constants, or keep nearest and state 61 %, as ARCHITECTURE already does. |
| R7 | INFO | The builtin `inst.test` is not counted. The T00c soak renders 512 test voices under the default limit of 128 with `voiceLimitSteals 0` (seen in its stats). Tests that use `inst.test` never exercise D4. | Leave it, or give `inst.test` the two overrides if a CPU test with test voices should honour the limit. |
| R8 | nit | `kVoiceLimitChoices` (voice_alloc.h) is unused. `native/core/build-d4-clang.log2` is committed: `.log2` escapes the `*.log` ignore. | Drop the constant or use it in `Model::setVoiceLimit`; `git rm --cached` the log. |

## Code read for real-time safety

- **`Graph::limitVoices`:**
  - Runs after each NoteOn on both the single-slot path and the `kAllSlots` path.
  - Uses a stack array of 48 `Instrument*`, a sum of 48 O(1) counts, and at most `kMaxLimitStealsPerNote` × 2 passes
    × 48 candidate scans of 160 pool slots. Nothing allocates and nothing locks.
  - The "instrument kept it" `break` guards against spinning.
  - Ties never prefer the instrument just played, so its new voice is not the victim.
- **The limit value:** `voiceLimitReq_` is an atomic the audio thread reads once per quantum, after `drainCommands()`.
- **Steal times:** synth and sampler report `releasedAt` / `startedAt` in the same base (`frame / sr`), so steal order
  across instruments is consistent. `oldestVoice` uses the time the instrument's own `makeRoom` would use, including
  the synth's `atTime` clamp.
- **`VoicePool::playing_`:** Held → Released keeps the count, and `markKilled` / `destroy` decrement it only for
  counted states. The 4000-step random test cross-checks it against a recount. `makeRoom`'s victim order is unchanged
  because the old inline loops became `oldestReleased` / `oldestPlaying`, a pure refactor; 108/108 byte-identical
  renders confirm it.
- **Retiring channels** are counted and can be stolen from, as D4 asks. A retiring synth after `kill()` still counts
  until its next render destroys the voices; that window is harmless.
