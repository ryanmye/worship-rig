# core3f (CORE3 prebuild race, runtime_preload stalls, CAP size rule): skeptic review (2026-11-27)

Verdict: **MERGE.** The prebuild race is real, and the hold fixes it. I reproduced the CI failure on the base without
the builder's test hook and confirmed that the lane removes it. One test-strength defect is fixed (S1): the new
regression case passed with a hold that the prebuild lane ignores. The previous reviewer's F1–F3 fixes hold. The CAP
rule matches D9 and the O4 note under D33. The open items are minor and are listed in §5.

Under review: the builder's commits plus the first skeptic's F1–F3 (tip 1aa78c9, on 5c7ed2d). I took over after a
box restart. `git merge-tree` onto origin/v2-native (ea74f95) is clean: v2-native has changed nothing under
`native/core` since 5c7ed2d except `third_party/README.md`. `app/js/engine/` is untouched
(`git diff origin/v2-native...HEAD -- app/js/engine` is empty). Probes, logs and loop summaries are in
`/home/claude/scratch/core3f-sk/` (not committed). `scratch/core3f-sk/wt` is a detached probe worktree.

## 1. T1: the prebuild race (PrebuildHold)

**The interleaving.** On a switch, `SongGraph::prepare` → `startFresh` runs once per slot:
`takePrebuilt(key)` → `promote(job)`. Under the worker mutex, `promote` does one of three things:
- a job that is done or still queued in lane 1 moves to lane 0 and is adopted;
- a job that lane 1 has popped (`runLane == 1`, not done) is "busy", and the switch posts its own copy.

The mutex is released between two slots. Lane 1 is one FIFO thread at nice 10 / QoS utility. If it finishes its job
in that gap, it pops the song's next queued job, and the next slot then finds that job busy. Every gap adds one more
chance, so the number of duplicates is bounded only by how many gaps lane 1 finishes a build in. A preempted control
thread makes the gaps long. That matches the CI evidence (8 adopted, 2 busy).

**The fix is correct.** `holdPrebuilds` raises `held_` under `mu_`, and lane 1's wait predicate refuses to pop while
`held_ > 0`. The hold is taken before `discard` and before the first `promote`. So the set of the switch's jobs that
lane 1 holds is frozen at the job it is running at that instant: at most one is busy. What I checked:
- **Deadlock.** Nothing inside either hold scope waits for a lane-1 job. `prepare` runs discard / keepPrebuilt
  (reprioritize: mutex only), startFresh (promote / post: mutex only), the inline sampler `build`, reverb `stage`
  and evictPrebuilt (marks only). `onRateChanged` runs the same plus `dropPrebuilt` and the retiring synth.js
  `WaveBank::get` loop. A bank build that lane 1's running job is doing completes, because a running job is never
  held. `finish()` (which waits) is only called from `takeBuilt` at commit, outside the hold.
- **Nesting and exceptions.** RAII. `releasePrebuilds` notifies `cv_[1]` only at depth 0. The spurious wake of the
  `testPrebuildDelayMs` wait re-checks its predicate.
- **No worker yet.** `PrebuildHold(nullptr)` is a no-op. That is right: `prebuild()` and `discard` only create jobs
  through `worker()`, so a null `worker_` means no lane-1 work exists. Offline mode has no worker, so fixtures
  cannot change (confirmed below).
- **A popped but unwanted job** (skipped, state still Queued, `runLane == 1`) can't be in `prebuilt_`: eviction
  removes it, and discard keeps only `!unwanted` jobs.
- **The superseded plan's queued jobs**, moved to lane 1 by discard, cannot start under the hold either. A unit that
  both songs share is adopted, not built twice.

**Independent reproduction, without the builder's hook.** I added an env-gated 30 ms `sleep_for` in `startFresh`
after each slot that adopted a still-pending prebuilt job. This stands in for a preempted control thread, and only on
the switch back to B. Then I ran test :353 ("CORE3: supersede …", "switch back to B") 10 times on each build:

| build (g++ Release, probe worktree) | switch back to B: adopted / busy | `busy <= 1` |
|---|---|---|
| base 5c7ed2d, no sleep | 9 / 1 (10/10) | pass |
| base 5c7ed2d, 30 ms sleep | 5–7 / 3–5 (10/10) | **FAIL 10/10** (the CI shape) |
| lane, 30 ms sleep | 9 / 1 (10/10) | pass (only the injected tick-gap line fails) |
| lane with the hold ignored in lane 1's predicate, 30 ms sleep | 6–7 / 3–4 (5/5) | FAIL |

A first attempt slept on every slot of every prepare. That gave 10 / 0 on both builds: the sleeps during the earlier
prepares let lane 1 finish all of B before the switch back. Sleeping only on slots that adopt a pending job puts the
gaps where the race is.

**S1 (fixed, 6c88d33): the new regression case did not guard the fix.** `testWaitPrebuildStart` returned
immediately when `held_ > 0`. So with the hold in place, the "slow control thread" hook never slowed anything down.
I mutated lane 1's wait predicate to ignore `held_`, and the new case "core3f: a switch takes its prebuilt units in
one step" still **passed 5/5 at 9 / 1**. The builder's "unfixed 0 / 10" came from removing the hold altogether
(`held_` stays 0, so the hook waits). The fix: while held, the hook still waits `ms / 100` for lane 1 to start a job
(200 ms per slot normally, 1.2 s sanitized). When the hold works, lane 1 never starts one, and the wait times out.
- Same mutation after the fix: **5/5 FAIL** (1–4 adopted, 6–9 busy).
- Lane: 5/5 pass at 9 / 1. The case takes about 2.3 s.

The doc comments (build_worker.h, test_core3.cpp) and CONTRACT_CHANGES "core3f" now say this.

**Worker counts.** The builder's point stands: BuildWorker always has two threads (one per lane). Only the decode
pool scales with `hardware_concurrency`, and the race case has no sampler. Real 3–4 core runs are not possible on
this 2-CPU box (not verified).

## 2. T3: runtime_preload checkLive and long iterations

- `iterStart` is taken after `wake_.try_acquire_for`, so idle waiting is never counted. After F1 the record is made
  before `flush()`. Whatever that flush delivers (the reply that closes a checkLive window) is therefore ordered
  after the record. F1's case reads `longIterations()` inside `on_event` on the control thread, which makes it
  deterministic: an iteration recorded after its flush is read as 0, before it as ≥ 39.
- checkLive still fails a held loop. It fails any iteration that overlaps the window and reaches the adaptive bound.
  A gap with no long iteration fails only past 1 s (3 s sanitized). It is no weaker for the defect it guards (the
  CORE2A "decode on the control thread"), because that defect is one long iteration. The previous skeptic's
  mutations (a 300 ms hold in prepare's processMessage, and one in the reply's own iteration) failed 3/3 each.
- F3 (the bounded drain before `buildsPending == 0` after a rate change) is right. The dropped 48 kHz job that lane 1
  was building runs to its end, unwanted. Under the hold, no other stale-rate job can start before `dropPrebuilt`
  marks them.

## 3. T2: CAP against D9 and the O4 note under D33

D9: a save past 2,000,000 warns and is not refused, and a restore is allowed up to 1.25×. The O4 note under D33: an
add / duplicate past 2,000,000 warns and goes through, and is refused only past 2,500,000 so that the library's own
backup stays restorable. The lane applies that one rule (`restoreCapRefusal`) to `addSong`, `duplicateSong`,
`setChart` (and the raw `songs.<id>.chart` write), `addPackSong` and `topUpPacks` (adds and in-place updates; a
shrinking update always fits). A merge import keeps the 2 MB refusal, which is correct: D9 grants 1.25× to a restore
only.
- The shell tests cover both sides of each limit:
  - the `library-size` warning past 2 MB, and exactly one `library-full` notice past 2.5 MB;
  - nothing is written on a refusal;
  - the export restores.
- F2 (the song menu's Keep + Add to setlist toasted twice) is fixed. I checked every caller of `addFromBank` /
  `keepTrial` (Settings, bank sheet, trial banner, song menu): each skips its own toast on `notified`.

## 4. Gates (tree 6c88d33 for native; JS tree in §4.2)

### 4.1 Native

GATES_NATIVE

### 4.2 JS (gates.mjs)

GATES_JS

## 5. Open questions / notes (none blocks the merge)

- **O1 (CAP, for Ryan).** `setChart` is a save under D9's wording ("a save … warns but is not refused"). The lane
  treats a chart as an add and refuses it past 2.5 MB, as the brief (UI6-cship O1) asked. Ordinary edits (notes, …)
  past 2.5 MB are still not refused, so the library can still outgrow its own restore cap that way.
- **O2 (CAP, cosmetic).** A chart refused at the restore cap shows its message twice: inline in the import dialog
  (`showError`) and as the `library-full` toast. The text is the same, but it is not the same toast twice, and the
  dialog needs the inline copy. Not changed.
- **O3 (CAP, pre-existing).** `keepTrial` copies a trial song's changed fields with `store.set` after
  `addPackSong` has checked the pack song's size. A chart added during the trial that would take the library past
  2.5 MB is dropped without a word, under a "Kept" toast. Before the lane this happened at 2 MB.
- **O4 (T1).** `onRateChanged`'s hold also spans the retiring synth.js `WaveBank::get` loop. A first use of a bank
  at the new rate takes 80–300 ms, and lane 1 sits idle for it. It is rare, and holding through `dropPrebuilt`
  keeps lane 1 from starting a stale-rate job, so I left it.
- **O5 (T3).** `longIterations()` keeps the last 256. A sanitized window with more than 256 long iterations after
  a held one could drop the held one (a false pass only). Not seen; not changed.
- **Not verified:** CI / the Mac (nothing pushed), and real 3–4 core worker counts.

## 6. Merge

A rebase onto origin/v2-native ea74f95 has no conflicts (`git merge-tree` is clean). If a later v2-native commit
appends to CONTRACT_CHANGES.md, keep both sides. Remove LANE.md in the merge commit.
