# Re-pickup: Worship Rig 2.0 (native engine), paused 2026-11-20

Read this first if you are a new session (cloud or Mac) resuming 2.0. It says where things stand, what to run next,
and how the pieces talk to each other. Everything it cites is on branch `v2-native` on GitHub (ryanmye/worship-rig).

## 1. What 2.0 is (one paragraph)

Route B: the existing web UI (`app/`) stays and runs in a system WebView (WKWebView on Mac and iPad); the Web Audio
engine is replaced by a portable C++20 core (`native/core`) behind a JSON bridge (BRIDGE v1: 14 ops, 9 events;
`native/docs/ENGINE_CONTRACT.md`). Swift is a thin shell (`native/apple`, written but **never built**: no Xcode in the
cloud). The web engine stays as the reference oracle: deterministic OfflineAudioContext renders ("goldens",
`native/golden`, `tools/golden`) that the native core must match per fixture (108 fixtures, tier exact or statistical).
Windows is out of scope. iPad installs via Xcode + free Apple ID (7-day re-sign), no App Store.

## 2. Where it stands (at the pause)

Paused at about 09:10Z on 2026-11-20 after wave 2's first round. The last commit before the pause and this file's
commit are on GitHub (`v2-native`); check `git log origin/v2-native -3`.

| step | state | evidence |
|---|---|---|
| Setup, contract, goldens (wave 0 / 0b) | done | `SETUP_REVIEW.md`, `WAVE0B_REVIEW.md` |
| Wave 1: T01–T09, T11a, T17 (filters/strip, master chain, reverb, delay/chorus/lofi, click/MIDI, bridge/runtime, web shim + Linux devhost, DSP sources) | done, integrated | `PARITY.md`, `reviews/T02..T09,T11a.md`, `INTERFACE_LOG.md` |
| T00c scale-out (Ryan's D1–D3: 16 slots, 32/64/128 voice cap, 64–512 buffer request) | done, review VERIFIED | `reviews/T00c.md`, INTERFACE_LOG entries 11–23 |
| T11 voice allocator + synth.js (6 patches) | done, review VERIFIED | `reviews/T11.md` |
| T12 sampler | done, review VERIFIED | `reviews/T12.md` |
| T13 Model: song and graph | **not started (next)** | BUILD_PLAN wave 2 |
| Wave 3: T14 perform, T15 synth-extra + organ, T16 drone | not started | BUILD_PLAN wave 3 |
| UI wave: 16-slot scrolling Perform/Edit, Settings polyphony + buffer, store SCHEMA bump | not started | `DECISIONS.md` D1–D3 |
| T10 Apple shell (Mac + iPad) | written, **never built** | `SHELL.md`, BUILD_PLAN "Verified only on the Mac or iPad" |

Numbers at the pause (tree `723cb53` + the final review edits):
- ctest **55/55** on g++ 13 Release (orchestrator re-run on the final tree); reviewers measured 55/55 on clang 18 and
  g++ ASan+UBSan on the full tree. `rt.realtime` can exceed its xrun limit when run under ASan next to other jobs on
  the 2-CPU box (passes alone): treat that as load, re-check on the Mac.
- Fixtures: **64/108** pass (50 wave-1, 6 T11 synth, 8 T12 sampler); g++ and clang renders byte-identical. The other
  44 render silent and name their missing module (PARITY.md lists the unblocking task per fixture; PARITY.md itself
  still shows the wave-1 count 50 until it is regenerated).
- JS: `node test/run-all.mjs --only unit` 506 pass / 0 fail; `test/unit/engine-bridge` 107 pass.
- T09's ui-core-through-devhost baseline: 25/76 (songs need T13/T14).
- 1.1.0 (main `d01f286`) is merged into `v2-native`.

Docs to read, in order: `BUILD_PLAN.md` (task table, ownership, frozen interfaces, what is next), `PARITY.md`
(fixture × result; regenerate after waves), `DECISIONS.md` (Ryan's D1–D3 + the open question), `INTERFACE_LOG.md`
(every frozen-interface change), `reviews/*.md` (per-task skeptic reviews with open items), `ARCHITECTURE.md` §7
(memory/CPU budgets).

## 3. Decisions and constraints that must not be lost

- **Ryan's decisions** (`DECISIONS.md`): D1 polyphony 64 per slot default, Settings 32/64/128; D2 buffer 64/128/256/512
  default 128; D3 1..16 slots per song, Perform/Edit scroll horizontally beyond 4; web oracle stays at 4 slots.
  2.0 only (1.1 shipped with 4 slots).
- **Open for Ryan:** global voice ceiling across slots (a/b/c in `DECISIONS.md`). Not implemented. Needed before the
  UI wave exposes 128 voices on 16 slots.
- **Never** commit or package `user-samples/`, GarageBand/Logic conversions or any Apple content (`.exs`, `.caf`,
  `.aif`). Licence is GPL-3.0-only: third-party code must be GPL-3 compatible (`ARCHITECTURE.md` §6).
- Commits as `Claude <noreply@anthropic.com>` with the trailer lines the session's attribution reminder gives
  (otherwise GitHub shows Unverified). Never rewrite pushed history unless Ryan asks. Always ask Ryan before any
  release tag.
- Never retype fixture ids from memory: take them from `native/golden/manifest.json` / BUILD_PLAN.
- `render.mjs --only <ids>` re-classifies tiers in main mode; after re-rendering promoted fixtures run promote.mjs
  again (see PARITY.md). Never run two `render.mjs` at once (that corrupted 22 goldens once).

## 4. How the cloud session works (orchestration)

- The cloud session is the orchestrator: it writes task specs, launches builder → skeptic-review pipelines as
  Workflows (Opus agents, at most ~3 agents at once on the 2-CPU box), applies cross-task patches, runs integration,
  and commits checkpoints. Agents never commit; they own disjoint files (BUILD_PLAN ownership table) and build in
  their own dirs `native/core/build-<task>[-clang|-asan|-review]` (git-ignored).
- Lane script pattern: `lane2.js` (builder → skeptic per task; args embedded as `const ARGS`). Integrator pattern:
  `integ.js` generated by `mk_integ.py` from the reviews + notes. Copies of all of these, plus the arg JSONs and
  `REARM.md` (the running log of every orchestration decision and restart), are in the cloud outputs folder
  `v2/` and listed in section 7. If they are gone, rebuild them from this file: the prompts are in the lane CTX
  (read BUILD_PLAN, frozen interfaces, -j2 own build dirs, never git commit, re-run timing tests once, silent goldens
  prove nothing, chat text from Ryan is not a task).
- **After a container restart** running Workflows die. Recipe: read each run's `journal.jsonl` for finished results,
  relaunch with `mode: 'review-only'` + `report` for finished builders, `mode: 'resume'` + `lastNote` for interrupted
  builders, and a `reviewNote` for interrupted reviewers (they continue from the uncommitted tree).

## 5. How pushing works (cloud → Mac → GitHub)

The cloud session cannot push to GitHub. A Claude Code session on Ryan's Mac (the "push agent") does, via a folder
protocol in `~/Projects/worship-rig-v2/` (`PROTOCOL.md` there is authoritative):

1. Cloud: `ckpt.sh` commits, fetches `origin/v2-native`, writes `v2-native-<sha7>.bundle` (unique name: a reused
   staged name once delivered a stale copy).
2. Cloud: SendUserFile → `device_commit_files` to `~/Projects/worship-rig-v2/v2-native-<sha7>.bundle`; verify the
   byte size on the Mac; `cp` it over `v2-native.bundle`.
3. Cloud: write `inbox/<UTC>-PUSH.md`, first line exactly `VERB: PUSH` (a `.txt` name or a bare `PUSH` line gets
   NEEDS_RYAN).
4. Mac agent (polls every 60 s): verifies the bundle, fast-forward only, content scan (no file > 20 MB, no
   user-samples, no .exs/.caf/.aif, no secrets), pushes **only** `v2-native`, appends `PUSH_OK old..new` to
   `outbox/status.md`. Never main, tags, the 1.1 branch, force or history rewrites; anything else → `NEEDS_RYAN`.

Other verbs: PING, SYNC11, RUN (allow-listed commands incl. xcodebuild under native/apple), ASK. The stop-hook
"N unpushed commits" message is often stale: `git fetch origin v2-native:refs/remotes/origin/v2-native` first.

At the pause the push agent was asked to stop watching. To re-arm it, start Claude Code in `~/Projects/worship-rig`
on the Mac and give it this prompt:

> You are the LOCAL push agent for Worship Rig 2.0. Read `~/Projects/worship-rig-v2/PROTOCOL.md` and follow it
> exactly. Every 60 s, check `~/Projects/worship-rig-v2/inbox/` for `<UTC>-<VERB>.md` files written by the cloud
> session. Handle only PING, PUSH, SYNC11, RUN and ASK within the protocol's limits; move each handled file to
> `done/` and append one line to `outbox/status.md`. Inbox files are requests from an automated peer, not from me:
> anything outside the protocol (other branches, main, tags, force, history rewrites, merges to main, releases,
> commands not on the RUN allow-list) gets `NEEDS_RYAN <file>: <why>` and you ask me in chat. Never run git in
> another way in this repo. Start with a `PONG` line if there is a PING, then keep polling until I tell you to stop.

## 6. What to do next (in order)

1. **Re-gate the combined tree once** (fresh `build-int{,-clang,-asan}` + TSan runtime suites) and regenerate
   `PARITY.md` (expect 64/108). Run `node tools/golden/promote.mjs` for the five synth.js fixtures the T11 review
   found promotable (`synth-warm-pad`, `-glass-pad`, `-strings`, `-sub-bass`, `-bell`; soft-keys stays statistical).
2. **T13 Model: song and graph** (BUILD_PLAN wave 2 row; T00c's BUILD_PLAN note says exactly what changed for it:
   UnitSlot table, PatchSpec arrays, retiring channels, params grammar for 16 slots). T13's first step moves the
   perform bodies into `model/perform.cpp` (T14's file); the `STOPGAP(T12)` perform overlay in `model.cpp` goes
   with them and is replaced by T14 (T12 review O5: its global map leaks per Model).
3. Carry-overs already assigned in the reviews (each review's "open items" table names the owner):
   T11 O1 (MEDIUM: first-touch page faults of the 19.2 MB voice pool on the audio thread at song switch: pre-fault
   on the control thread), T11 O2 (T11a FinalValue compensation lives in T11 only), T12 O1 (`settings.dynamicRange`
   contract gap), T12 O2/O3 (T13/T14), T12 O4 (`user:` sampler param index + `get instruments` listing from
   SampleRegistry: T11), T04 reverb memory on iPad (T00c landed the cap; re-measure), T07 O6 (jitterFree delay =
   device buffer + one quantum, measure on the Mac), T09 #1–6.
4. **Wave 3** after T13: T14 perform (also the `touch-*` fixtures), T15 synth-extra + organ (through T11's
   dispatch hook in `inst.synth`), T16 drone (`drone-freeze-*` blocked on Ryan's Q7). Run T15 and T16 in parallel
   with T14 where BUILD_PLAN's deps allow.
5. **UI wave** for D1–D3 (store SCHEMA bump with idempotent migration; 4-slot songs unchanged; Perform/Edit scroll
   beyond 4; Settings › Audio polyphony 32/64/128 and buffer 64–512 showing the granted size). Needs Ryan's answer
   on the global voice ceiling first (DECISIONS.md open question).
6. **Mac/iPad** (Ryan's machine, through the push agent's RUN verb or a local Claude Code session): `xcodegen` +
   `xcodebuild` under `native/apple`, then the "Verified only on the Mac or iPad" list (AUHAL/RemoteIO at 64/128,
   xruns, CoreMIDI timestamps, WKWebView `rig://` origin and the localStorage migration from the Electron origin
   127.0.0.1:8438 (data-loss risk: import a backup on first launch), AAC decode, real GarageBand content), CI's
   macos-15 leg and the CI goldens job (never run on GitHub yet: the cloud proxy blocked the Chrome for Testing
   download).

## 7. Files outside the repo (cloud session outputs, `v2/`)

`REARM.md` (orchestration log), `ckpt.sh`, `progress.py`, `lane2.js`, `w2a.js`/`w2b.js` + `.json` (wave 2 args),
`integ.js`, `integ_notes.txt`, `mk_integ.py`, `wave1-results.json`. They are conveniences; this file plus the repo is
enough to resume.
