# CORE2A (asynchronous sample preload, PARITY "UI parity" row 1): skeptic review, 2026-11-22

Verdict: **VERIFIED** (one claim overstated and corrected here; two review tests added). `cache preload` no longer
stops the control loop, a realtime `prepare` is answered once its samples are decoded, a song switch is decoded ahead
of preloads and of a superseded switch, and every new test fails on the unfixed core. The gate holds on this review's
own builds and no fixture moved. The ui-core raw count is 76 and 77 over two runs; the one failure is a suite-side
race, not a core defect.

Tree: `v2-native` working tree (CORE2A and CORE2B builders, uncommitted) plus this review's edits. Own build dirs
(fresh, real directories, `-j2` at most in total, one heavy job at a time): `native/core/build-c2sk` (g++ 13 Release),
`build-c2sk-clang20` (clang++-20 Release, `-Werror` via `RigWarnings.cmake`), `build-c2sk-asan` (g++ RelWithDebInfo,
`RIG_SANITIZE=address;undefined`), `build-c2sk-tsan` (g++ RelWithDebInfo, `RIG_SANITIZE=thread`),
`native/devhost/build-c2sk` (g++ Release). Playwright through the existing 1194 -> 1243 mapping (`scratchpad/uisk/pw`).
All deleted after this report.

## Gate, measured here

| check | result |
|---|---|
| ctest g++ 13 Release | **82/82** (`-j2`), 0 warnings |
| ctest clang++-20 Release `-Werror` | **82/82** (`-j1`), 0 warnings |
| ctest g++ ASan+UBSan | **82/82** (`-j1`, `rt.realtime` included), 0 warnings, no sanitizer report |
| ctest g++ TSan, every suite whose threads CORE2A touches (`-R "runtime\|samples_\|sampler\|song\|model\|bridge\|sleep\|core2b\|t00c"`) | **16/16**, no report (`unit.runtime_preload` 6/6 incl. the review cases, `runtime_cache`, `runtime`, `samples_*`, `sampler`, `song`, `model`, `bridge*`, `sleep`, `core2b`, `t00c`) |
| fixtures (`rig_render`, all 112) | g++ vs clang-20 byte-identical 112/112; vs the builder's g++ renders 112/112; vs the UIC skeptic's renders (before CORE2A / CORE2B) **112/112: no fixture moved** |
| `tools/golden/parity.mjs --twin <clang-20>` | **exit 0**; 112/112 at the manifest tier, 110 exact; "unexpected failures: none" |
| `node --test test/unit/engine-bridge/*.test.mjs`, `RIG_DEVHOST` = this review's devhost | **131 / 0 / 0** |
| ui-core on `rig-devhost --no-adapter` (raw) | **76, 77 / 77**; no bridge error reply; the two known warns; `sanitizer: (none)` |
| `app/js/engine/**`, `native/golden/**` | unchanged (`git diff` empty) |

## Items

- **Required behaviour from 1.x: correct.** Checked against `audio.js` `prepare` (lines 586-648: builds, then
  `await Promise.all([reverbP, ...created.map(sc => sc.inst.ready)])`, then the token check) and `preload` (906-948:
  6 workers per call, pins at the start and again at the end, `ready {phase:'preload'}`), and `controller.js`
  `selectSong` / `reprepare` (`my !== seq` drops an older prepare, commit only after the prepare resolves). One
  difference, harmless: 1.x resolves a superseded `prepare` after its own decodes, 2.0 answers it at once; the
  controller drops it either way. A second, nit (O3): 1.x awaits only the instruments it created, 2.0 also waits for
  in-flight samples of reused sampler slots.
- **`cache preload` asynchronous: done, tested, fails without the fix.** The bridge calls `preloadAsync` and replies
  from `pump()`; offline the inline runner answers before `handle` returns. Reply shape unchanged. The `Req` copy drops
  `r.m` (it dies with the message), and `reply()` never reads `m`.
- **Realtime `prepare` waits for its samples: done, tested, fails without the fix.** `samplerLoadKeys` computes the
  same keys `SamplerService::build` requests (`keyOf(url, midi, decodeOpts.maxSec)`); `whenSettled` adds a no-ref
  waiter after the sampler's own waiter, so the reply goes out after the load's final table exists. The reply text is
  byte-for-byte what `ok()` sent. Without an id, or offline, nothing changes.
- **Supersede: done for song switches, tested.** A newer `prepare` flushes older pending replies at once (case 3).
  Priority 0 jobs always run before preloads (1) and re-warms (2); a join on a key still queued re-posts its job at
  the new priority with a shared `claimed` flag (the first copy decodes, the others return before touching `this`).
  **Overstated for preloads (corrected):** "newest first" holds per job, not per preload. A preload keeps at most 6
  decodes queued and posts the next as one finishes, so its follow-up is the newest job in the pool and two preloads
  interleave. Measured (case 4, one worker on this box): the newer preload answered at 4.40 s, the older at 4.53 s; a
  real newest-first would answer the newer at ~2.5 s. The builder's `CHECK(!replied(10))` / `a.first > b.first` held
  by a ~3 % margin only. 1.x does not order two preloads either (parallel `decodeAudioData`) and the requirement is
  only "never dropped", so this is a claim fix, not a defect: case 4 now checks both answer, both are loaded and ticks
  flow, with the reason in a comment; INTERFACE_LOG CORE2A-3 corrected.
- **Worker priority: done.** `setpriority(PRIO_PROCESS, gettid, 10)` per worker on Linux, `QOS_CLASS_UTILITY` on
  Apple. Not measured here beyond the builder's "no difference on this box".
- **`sampler_service` (T12, out of lane): correct, needed.** Units attach only at `SongGraph::commit`, and `onCommit`
  is only called from there, so `commitsAtBuild == commits_` exactly means "built for a plan not yet committed". The
  held tables go out at the commit's `when`, after its `AttachUnit` commands; a superseded plan's table reaches the
  slot with an old `instSeq`, is refused and returns as Garbage (leases released there); a channel the commit leaves
  without a sampler releases them at once. Offline nothing changes (`pending == 0` inside `build`). The mackit O1
  case (`unit.runtime_cache`, 128 voices heard) covers it.
- **Real-time / thread safety: no finding.** Nothing new runs on the audio thread; `sendOwned` of a final table is the
  same path as before. `queued_`, `pendingPrepares_`, `unattached_` are control-thread only; workers touch only the
  `claimed` atomic and their own data; `seq_` is under the pool mutex. Teardown: the pool drops queued jobs and the
  cache never calls pending waiters, so the `&e` captured by the `prepare` / `preload` callbacks is never used after
  `~Engine` (ASan and TSan clean, including the teardown case).
- **Tests.** The builder's 4 cases fail 4/4 on the builder's base binary `scratchpad/core2a/rig_tests.base` (checked
  to hold no `samplerLoadKeys` symbol, i.e. the unfixed core with the new test file): play answered after 4150 ms, one
  tick in 4.55 s, prepare answered at once, the second preload's gap 2.28 s. Fixed core, g++: play 0.13 ms, largest
  gap 36 ms over 136 ticks, prepare after 2.30 s, vibes ready 2.24 s after its prepare; TSan: 0.27 ms, 44 ms, 2.81 s,
  2.47 s. The `runtime_cache` edits are right (the teardown case's `reply(3, 1).empty()` has 30-70 ms against seconds
  of decoding).
- **Review tests added** (`test_runtime_preload.cpp`, task-owned): the design's central claim "a song switch never
  waits behind a preload" had no test. (5) a `prepare` of celesta 0.3 s into a 178-sample preload is answered after
  2.24 s (88 samples) while the preload is still loading; the preload answers at 6.77 s; gaps < 100 ms; the commit
  lands. (6) a `prepare` of vibes, whose samples the running preload has queued (joined keys re-posted at priority 0),
  is answered after 2.24 s with vibes loaded and salamander not yet. Both pass on g++, clang-20, ASan and TSan.
- **ui-core numbers: confirmed.** The builder's logs (`scratchpad/core2a/raw{1,2}.jsonl`) give 19 / 18 gaps over
  100 ms, 4 / 5 over 400 ms, max 743 / 754 ms, none over 400 ms with a preload in flight. This review's runs: 23 / 14,
  1 / 3, max 438 / 618 ms, none with a preload in flight; 182 preloads per run, all answered (longest 8.2-10.8 s,
  during which ticks kept flowing). Every factory song, v11-metronome and v11-decisions passed in both runs.
- **Docs.** INTERFACE_LOG CORE2A-1..7 match the code; no frozen file changed (none of the touched files is in
  BUILD_PLAN "Frozen interfaces"), so no `INTERFACE-CHANGE` marker is due; `hello.minor` 5 (CORE2B) names CORE2A's
  timing. CONTRACT_CHANGES "## CORE2A" is accurate for switches.

## Open items

- **O1 (ui-core suite, not core): polish-2A banners "that Esc did not panic" is a read race.** Failed in 1 of 2 full
  runs here and 1 of 2 for the builder; passed 4 of 4 alone (`--grep`). In the failing run the core emitted
  `notes {held:[64]}` 0.1 ms after the `play`, and no panic, note-off or `allNotesOff` reached it in the next 300 ms:
  so the page most likely read `holds(64)` (fed by the core's `notes` event) before that event arrived, right after a
  screenshot on a loaded box (inferred from the log, not traced in the page). Fix in the suite: `await page.waitForFunction(() => window.__t.holds(64))` after the `noteOn` and before Esc.
- **O2 (T11 / T15 / T13): the remaining tick gaps come from `prepare` of synth / organ slots.** Every gap over 150 ms
  in both runs starts within 35 ms of a `prepare` with synth or organ slots, and the reply goes out as the gap ends
  (run 2, prepare to reply: gospel + warm-pad 0.62 s, glass-pad + sub-bass 0.57 s, dx-epiano + juno-pad 0.48 s,
  strings + glass-pad 0.34 s, gospel + poly-stab + synth-bass 0.13-0.20 s):
  those units are built synchronously inside `Model::prepare` on the control thread. A note played then is that late.
  Not a sample decode, so outside CORE2A; recorded in PARITY's run table. Fix: build them off the control thread (as
  1.x builds in `prepare` while its main thread stays responsive) or cache the tables.
- **O3 (nit, T08 / T06):** `samplerLoadKeys` includes reused sampler slots, so `prepare` also waits for their samples
  if they are still in flight (1.x awaits only created instruments), and `whenSettled` does not raise those keys'
  priority when a preload or re-warm owns them. Reachable only when switching to a song that reuses a sampler still
  loading; harmless beyond the delay.
- **O4 (nit, T12, pre-existing):** a sampler load that finishes after a commit whose `when` lies ahead of the audio
  clock is sent at once, reaches the old unit, is refused, and the new unit stays partial. The shim commits without
  `when` and only after the settled reply, so it does not reach this; a raw bridge client could.
- **O5 (nit, T06):** re-posted copies make `ThreadPool::pending()` overcount (nothing in production reads it).
