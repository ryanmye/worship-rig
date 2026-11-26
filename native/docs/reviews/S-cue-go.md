# Lane S3–S4 ("Cue, then Go", DECISIONS D6): skeptic review, 2026-11-24

Verdict: **PARTIAL.** On the web engine the cue / GO / Next state machine holds up. The S1 audit's risk 1 (double
Next skips a song) is fixed and tested. A real cold-song GO waits, keeps the playing song on screen and in the store,
then switches. The gate is green. This review fixed three defects, each with a test that fails without its fix:
- **S1**: a stale cue played a song from outside the set.
- **S2**: a cap timer was left behind.
- **S4**: Daylight Day contrast.

The **2.0 bridge path does not work as the builder assumed** (S3). The real native core never emits
`load {phase:'samples'}`, so the bridge's `_loaded` map stays empty. `songReady` is then `false` for every song with a
sampler slot, for good: those chips always read "not loaded", and every GO to such a song takes the wait path. The
tests still pass, and the switches still happen (28–94 ms late on an idle box), but the D6 load states are wrong on
2.0. A fix needs the core or the shim, not this lane's files. Two design points need Ryan's call: S5, Next ignores a
cue; S6, Program Change now cues for 1.x users.

The tree is `lane-s` (uncommitted, on `650df77`), plus this review's edits. Own build dir: `native/devhost/build-ssk`
(g++ Release, Ninja, `-j2`), deleted after use. Playwright used `PLAYWRIGHT_BROWSERS_PATH=/root/.cache/rig-pw`;
nothing was installed. The box was shared with another heavy agent, and suites ran one at a time.

## Gate (measured here, after this review's edits)

| check | result |
|---|---|
| shell unit / browser / electron (`xvfb-run -a node test/phase1/shell/run.mjs`) | **272 / 0**, **13 / 0**, **22 / 0** (unit includes the 8 new review tests) |
| `node test/run-all.mjs --only unit` | **PASS**: 529 pass, 0 fail, 10 skip |
| ui-core (web engine), run 1 / run 2 | **78 / 78**, **78 / 78**. The known races (v11-metronome, v11-decisions, polish-2A banners) did not fire. |
| ui-core on `rig-devhost --no-adapter` (once) | **77 / 78**. The 1 failure is v11-decisions (the known suite-side race; not counted). Lane S's own test passed. No bridge error reply, the two known warns, `sanitizer: (none)`. |
| settings (`test/phase2/settings/run.mjs`) | **86 / 86** (app, fixture, mac, bridge) |
| themes | **58 / 58**. The coverage JSONs were rewritten again; the new cue selectors are matched. |
| edit-v2 `--only integration` | **2 / 2** files (integration 13/0, integration-widths 5/0) |
| `native/contract/tools/build-engine-api.mjs --check` | up to date |
| console.error | **0** in every suite and in this review's own browser scripts (cold GO, 8 theme shots, bridge probe) |

## Findings

**S1 (fixed; medium, stage).** A cue, or a GO waiting for its samples, outlived its entry leaving the nav list:
- **Removing the cued entry from the setlist.** GO then played that song from outside the set: `currentIndex()` −1,
  no chip current. The GO control still said "Go: <song>".
- **Making another setlist current while a GO waited.** If the new set still held the playing song, the
  store did not change `currentSongId`, so nothing dropped the GO. It then switched to the old set's song, again at
  index −1.
- **Deleting the cued song.** This left `status.cue` stale, so the ✕ stayed on screen with nothing cued.

The fix is controller `dropStaleCue()`, called from `onStore` on any nav change before the `selectSong` path. It drops
a cue, or a waiting GO, whose song is gone or no longer in `navIds()`. A cue whose song is in the new set too
survives (by id). Reorder keeps the cue, which the existing `entryOf` fallback already handled.

**S2 (fixed; low).** The 30 s cap timer was cleared only when the GO ran. A GO dropped by `clearCue`, a new cue, Prev,
a direct switch or `dispose()` left a live 30 s timeout. That was harmless, since `run()` returned false, but it was
a leak past dispose, and the brief asks for none. The timer now lives on the GO record. `dropPendingGo` and
`dispose` clear it.

**S3 (open; high for 2.0, owner: core or shim).** On the bridge, `songReady` is `false` for every sampler song, always.
Measured on `rig-devhost` (null backend) once the whole 19-song set was pinned (`status.ready`):
- `engine._loaded.size` = 0.
- `songReady` was false for the 9 songs with a sampler slot.
- Those 9 chips read `data-load="cold"` ("not loaded"); the other 10 read "ready".

GO to a sampler song: `status.go.waiting` was true, the label read "Loading… goes when ready", and the switch came
after a `cache preload {pin:'none'}` round trip (94 / 64 / 28 ms). Afterwards `songReady` was still false.

The cause: the contract (ENGINE_CONTRACT §6 `load` row, and SHELL.md G5) says the core emits
`load {phase:'samples', loaded:{id:bool}}`. Only `mock-native.js` does. `native/core` emits only `start` and
`preload`, and offers `get sampleStatus` instead. main.js's "Loading n of N" read the same facade before Lane S, so
the top bar was already wrong on 2.0. Lane S turns it into behaviour.

The fix belongs to the core (emit `samples` after `preload` and `commit` decodes) or to the shim (ask `get
sampleStatus` after a `preload` reply, and fill `_loaded`). Until then, the claim "a warm song switches in the same
tick" is not true on 2.0. The mock-backed settings `[bridge]` mode cannot catch this.

**S4 (fixed; medium, a11y).** The cue marks used `--accent`. Daylight Day's `--accent` is a pale fill, which gives
**1.74:1** on a chip (`#f4b73f` on `#fdfbf7`) for:
- the "CUED" tag (11 px text: needs 4.5:1);
- the cued ring (non-text: needs 3:1);
- the GO control's "Go" caption and border.

They now read the existing theme hook `var(--accent-text, var(--accent))` (themes/README, mini.css), which is
**6.12:1** on Daylight Day. Every other theme has no `--accent-text`, so it is unchanged.

Measured at 1280×800 in all 8 themes:

| element | lowest | where |
|---|---|---|
| ready dot (`--ok`) vs chip | 4.78:1 | Sanctuary Day |
| dashed not-loaded ring (`--muted`) | ≥ 7.06:1 | |
| "Cued" tag / GO caption (after the fix) | 5.12 / 5.64:1 | Sanctuary Day |
| GO load text | ≥ 5.27:1 | |

Targets: chips 44 px, GO 48 px, ✕ 44×44. The load state doesn't rely on colour alone:
- ready is a filled dot, and not loaded is a dashed ring (a different shape);
- loading has the spinner;
- cued has the ring plus the word "Cued".

The aria-labels say the state in words: "3. Prayer Wash, key C: cued, ready", "6. Rhodes, key C: not loaded", "Go to
cued song: Prayer Wash, key C. Ready". Screenshots were looked at (Sanctuary, Daylight Day).

Cosmetic, for the visual pass:
- at 1280 the GO control's name truncates ("Prayer Was…") once the ✕ takes 54 px;
- the dots have no legend or tooltip.

**S5 (open; design, for Ryan).** With a cue set, "Next" means two different things:
- The on-screen Next button is the GO control, so it plays the **cue**.
- → , ⌘→, the menu, Electron global hotkeys and a learned **`nextSong` footswitch** play the neighbour of the playing
  song and silently **drop** the cue (documented: "Next / Prev = GO the neighbour").

A 1.x user whose only footswitch is learned to `nextSong` will tap a chip, press the footswitch, and get a song
other than the one shown on the GO control. The same split shows during a cued GO's load: `nextSong` steps from
the cued song, so a second press lands one past it.

Suggestion: `nextSong` with a cue set = `go()`, so the button, → and the footswitch agree; Prev stays as it is. This
is not changed here, because the builder chose it on purpose.

**S6 (open; design).** Program Change now cues by default, including for 1.x libraries that have `programChange` on.
See the view below.

**S7 (low).** Enter = GO with nothing focused. With nothing cued, that is Next, in every view, including Edit and
Settings, matching ←/→. 1.x did nothing on Enter, so a stray Enter after closing a dialog now changes the song.
Consider "Enter acts only when a cue is set".

A keyboard user who activates a focused chip with Enter cues it. A second Enter on the same, still-focused chip
**clears** the cue (the toggle) instead of going. A pointer tap blurs the chip, so this does not happen with taps.

**S8 (low).** A `warm()` preload that never settles keeps the song "loading" forever (the 500 ms chip poll keeps
running). Every later GO to that song then waits the full 30 s, because `warm` hands back the same stuck promise. The
bridge's link timeouts bound this on 2.0. I did not check whether the web engine's `preload` can hang; this was shown
only with a fake. Suggestion: drop the `warming`
entry when a GO's cap fires.

**S9 (note).** `songState` marks *both* entries of a reprised song "loading" while one of them loads (`targetId` is
an id). This is cosmetic.

## Rewritten tests (item 1): no guarantee weakened

- **controller `selectSong race`.** The old test asserted the skip: two Nexts gave `ids[2]`. It now asserts the fix:
  the same promise, one prepare, `ids[1]`. "Only the newest commits; a stale prepare that resolves later never
  commits" is kept through a direct `selectSong(ids[2])` racing it, with the same commit count, token and `appliedId`
  checks. Out-of-order resolution of two step requests is covered in cue-go "Next then Prev".
- **PC test.** "Ignored when disabled" is kept. Cue by default is added. Switch mode still asserts `currentSongId`
  and `status.songId`. Its new assertion "switching to the cued entry spends the cue" passes trivially: the `switch`
  branch clears the cue itself. It is weak, but it is an addition, not a loss.
- **settings.** The Learn row counts went 14→17 and 16→19, and the Advanced rows gained the two PC rows. Both are
  deliberate; the Learn names are kept.
- **ui-core.** Chip taps go through `pickChip` (tap, then GO if a cue is left). These tests no longer exercise
  "a tap switches", which is the deliberate D6 change, and the new Lane S test asserts "a tap does not switch".
  Every other assertion is unchanged. The themes `shoot.mjs` change is the same.

## Store (item 3)

The new settings `programChangeAction` and `programChangeChannel`:
- are absent until set;
- refuse bad values (−1, 16, 1.5, '3', true, 'jump', 'CUE', 3) and refuse nested paths;
- treat `null` as "remove" (the UI writes `null` for Cue / Any);
- are exported, kept by a replace-import, and have bad imported values dropped by `normalizeSettings`;
- keep `migrate()` idempotent (byte-equal on a second pass).

They are not device-local, like `programChange`.

## Module boundaries (item 4)

- Views call only `controller.*` (`cueSong`, `clearCue`, `go`, `songState`, `goTarget`) and `store.set`.
  setlist.js stays a pure view.
- main.js (the composition root) reads `controller.songReady`.
- `shared/params.js` stays pure.
- There is no AudioParam use, and no file under `app/js/engine` was touched by the lane or by this review.
- The style rules hold. Two new test names run 1–2 characters over 120; the test files already have hundreds of
  such lines.

## Fixed here

- `app/js/controller.js`: `dropStaleCue()` + its call in `onStore` (S1); `going.timer`, cleared in `dropPendingGo` and
  `dispose` (S2).
- `app/styles.css`: the cue ring, the "Cued" tag and the GO border / caption use `var(--accent-text, var(--accent))`
  (S4).
- `test/phase1/shell/cue-go-review.test.mjs` (new, 8 tests): S1 ×3, the cue surviving a reorder or a setlist switch,
  S2, a preload rejected by an engine restart, the set ends with an empty setlist, and the reprise twin. The S1 and
  S2 tests fail without the fixes (checked: 4 of 8 fail with the two edits commented out).
- `CONTRACT_CHANGES.md` "## Lane S": a "Skeptic fixes" bullet.

## Open items

1. **S3**: on the core or the shim, emit `load {phase:'samples'}` or poll `get sampleStatus`. Then re-run the bridge
   probe: the chips should read "ready" once pinned, and a warm GO should switch in the same tick.
2. **S5 / S6 / S7**: Ryan decides (Next vs the cue; the PC default; Enter without a cue).
3. **S8**: bound `warming`.
4. The visual pass (D6): GO name truncation and a dot legend.

## Is "Program Change cues by default" acceptable?

**Not as a silent change for 1.x users who have PC on.** D6 is about *taps*: a tap cues, and GO is deliberate. It
says nothing about Program Change. A 1.x player who switches songs from the keyboard's program buttons has no GO
control in reach, because that is the reason they use PC. After the update their program button does nothing
audible, mid-service, and the only clue is a ring on a chip. That fails silently, the stage risk Lane S was meant to
remove. The S1 risk that cueing addresses (another keyboard's patch change) is now handled by the new channel filter.

Recommendation:
- Keep `'cue'` as the default for **new** enablements: the Settings toggle writes `programChangeAction: 'cue'` when
  it is switched on in 2.0.
- Treat an **absent** action with `programChange: true` (every 1.x library) as `'switch'`.

That stays "absent until set" with no SCHEMA bump. Each user keeps the behaviour they had, and the safe one is
offered to people choosing PC now. The alternative, a one-time notice on first PC after the update, is weaker,
because it arrives on stage.

## Follow-up (builder, 2026-11-25): S3, S5, S6, S7, S8 addressed, pending the skeptic's re-check

Decisions: O-AW-2 (S5), O-AW-3 (S6), O-AW-4 (S3). Details and numbers are in CONTRACT_CHANGES "## Lane S",
"Follow-ups". Only node unit suites were run (shell unit **281 / 0**; `run-all --only unit` **534 pass, 0 fail,
10 skip**). The browser, devhost and Electron suites are still to run.

| finding | status | change | test |
|---|---|---|---|
| S3 | addressed (shim), pending re-check | `bridge-engine.js`: after each `cache preload` reply, `get sampleStatus` for its sampler ids (one-slot patch per id) fills `_loaded`, before `preload()` resolves; after `prepare`, only unknown ids, not blocking the token; one request in flight + one coalesced follow-up; the `samples` event still works | `test/unit/engine-bridge/sample-status.test.mjs` (5) |
| S5 | addressed | `nextSong()` with a cue = `go()` (learned `nextSong`, →, ⌘→, menu, bus / global hotkey); `prevSong` clears the cue and steps back | `cue-go-followup` (3); `cue-go` "Next replaces a cue" now asserts O-AW-2 |
| S6 | addressed | absent action + PC on = `'switch'`; `store.set` off → on writes `'cue'`; Settings writes both explicitly | `cue-go-followup` (4: reading, set paths, export / import / migrate, controller PC) |
| S7 | addressed; chip half browser-only | Enter = GO only on Perform, Settings closed, with a GO target; main.js eats Enter in other dialogs with nothing focused; Enter / Space on the cued chip GOes instead of clearing | `cue-go-followup` (1, controller); ui-core "Lane S" double-Enter + Edit checks (not run) |
| S8 | addressed | `warm()` capped at `WARM_MAX_MS` = 30 s: then `cold`, the next cue / GO asks again; cap cleared on settle / dispose | `cue-go-followup` (1); review S2 test updated to count the warm-up cap |

For the re-check:
- **S3 on `rig-devhost`.** Run the bridge probe again. Once the set is pinned, the 9 sampler chips should read
  "ready", `engine._loaded.size` should be > 0, and a warm GO should switch in the same tick. This needs the real
  core's preload timing (CORE2A: the reply comes after the decode). The `sampleStatus` request goes out once per
  preload and on `prepare` for samplers not yet known; count the `get` traffic against G8.
- **A stale `true`.** Pinned buffers evicted later still read decoded until a preload names the song again. A GO
  then takes the 1.x path (a direct switch; the engine keeps the old song until `prepare` resolves).
- **Turning PC off and on again.** A 1.x user with PC on (absent = switch) who does this gets `'cue'`, because it is
  an "off → on with no action stored". That is the letter of O-AW-3; Settings shows Cue while PC is off, so the UI
  says what will happen.
- S9 (reprise twins both "loading") is unchanged.

## Re-check (independent skeptic, 2026-11-25): S3, S5–S8

Verdict: **VERIFIED.** The five follow-ups do what the builder claims, on the real core as well as in the unit
fakes. On `rig-devhost` the sampler chips now read "ready" once their set is pinned, a GO to a decoded song switches
in the same tick, and a GO to a cold song waits and then switches. The extra `get` traffic is at most one request per
preload, and the prepare hot path is not delayed. The full gate is green; the only devhost failure is the known
v11-decisions race. This re-check fixed two low defects, each with a test that fails without its fix (R1, R2), and
brought SHELL.md G5 / G8 up to date. Nothing under `app/js/engine` was touched.

Tree: `lane-s` (uncommitted, on `650df77`) plus this re-check's edits. Own build dir `native/devhost/build-rck`
(g++ Release, Ninja, `-j2`), deleted after use. `PLAYWRIGHT_BROWSERS_PATH=/root/.cache/rig-pw`, nothing installed;
suites ran one at a time on a box shared with another heavy agent.

### Gate (after this re-check's edits)

| check | result |
|---|---|
| shell unit / browser / electron (`xvfb-run -a node test/phase1/shell/run.mjs`) | **282 / 0**, **13 / 0**, **22 / 0** (1 skip: L-14, macOS only). Unit = 281 + R2's test |
| `node test/run-all.mjs --only unit` | **PASS**: 535 pass, 0 fail, 10 skip (534 + R1's test) |
| ui-core (web engine), run 1 / run 2 | **78 / 78**, **78 / 78**. The known races did not fire. Lane S's test (double-Enter chip, Enter in Edit) passes |
| ui-core on `rig-devhost --no-adapter` (once) | **77 / 78**. The 1 failure is v11-decisions (the known race; not counted). Lane S passed. No bridge error reply, the two known warns, `sanitizer: (none)` |
| settings | **86 / 86** (app, fixture, mac, bridge) |
| themes | **58 / 58** |
| edit-v2 `--only integration` | **2 / 2** files (integration 13 / 0, integration-widths 5 / 0) |
| `native/contract/tools/build-engine-api.mjs --check` | up to date |
| console.error | **0** in every suite and in this re-check's own probes (bridge probe ×4, Enter probe) |

### Bridge probe on `rig-devhost` (null backend, real core)

The probe was a throwaway Playwright script, not committed. It does three things: library mode first, so far songs
stay cold, then a cold GO; then an 8-song setlist (448.6 MB, which fits the 600 MB budget) made current; then three
warm GOs to sampler songs. It also compares every song's `controller.songReady` with a direct `get sampleStatus` for
that song's full patch.

- **Pinned set (S3).** With the set pinned (`status.ready`, mode `setlist`, pinnedMB 448.6): all 8 `songReady` are
  true and the chips read `ready` (+ `playing`). `engine._loaded.size` = 2 (the distinct samplers in those songs).
  The shim agreed with the core on 8 of 8 songs in all three runs. The first review measured 0 and "cold" here.
- **Warm GO.** 6 of 6 GOs to decoded sampler songs left `go()` synchronously with `status.go.waiting` false, the
  controller's `targetId` set and the store already on the song, which is the same-tick switch. The commit came
  9–45 ms later (one 115 / 275 ms outlier, Anthem: synth + drone, no sampler wait).
- **Cold GO.** In library mode, Rhodes (one run) and Upright + Pad (another) read `cold`. A GO showed `waiting` true,
  the store kept the playing song, and the switch came after 1210 / 1991 ms. `songReady` was true afterwards in the
  run that checked again after 500 ms.
- **G8 traffic.** At most one `get sampleStatus` per `cache preload` reply, and fewer when preloads overlap:
  - Pinning the 8-song set: 7 preloads, 5 sampleStatus.
  - A warm switch: 1 preload, 1 sampleStatus.
  - A cold GO: 2 (its warm-up and the window).
  - The whole ui-core devhost run: 147 sampleStatus for 196 preloads and 102 prepares, 4.8 % of 3093 inbound
    requests.

  Reads, ticks and the 500 ms chip poll send nothing (unit test).
- **Latency.**
  - `preload()` now resolves after one more round. That is a median of 3.4–5.5 ms and a maximum of 23.5 ms from the
    preload reply to the sampleStatus request, and a round trip of ≤ 3.4 ms (median 0.2 ms).
  - The `prepare` token is not held back. Between a prepare reply and its commit, a sampleStatus request went out
    0.2 ms before the commit in 1 of 5 switches, and the commit gaps were 0.9–15.8 ms either way.
  - The later resolve moves `status.ready`, `pinSongs`' replace chain and the large-set warm loop by a few ms each.
    None of them is on the switch path. A cold GO's wait includes it, and it should.

### Findings

**R1 (fixed; low, owner shim).** A stale "ready" after a My Samples rescan. `CacheServiceImpl::reloadManifests`
invalidates the buffers of every user sample path. The shim's `prepare` refresh asks only about *unknown* ids, so a
user sampler stayed `true` until a preload happened to name it. A GO then took the direct path: 1.x behaviour, with
the old song playing until `prepare` decodes, so nothing wrong was heard. The chip, though, said "ready".
`reloadManifests()` now re-asks for every sampler id the shim holds as decoded or failed, in one coalesced round.
Test: `sample-status.test.mjs` "S re-check R1" (fails without the fix).

**R2 (fixed; low).** A `status` event could be emitted after `dispose()`. `warm()`'s race `then()` called
`publishCue(true)` with no `cueDisposed` check (only the late-settle branch had one). The S8 cap timers themselves were
cleared correctly. Test: `test/phase1/shell/cue-go-recheck.test.mjs` (fails without the fix).

**R3 (note, S3 coalescing).** I read the coalescing for races and found none:
- Ids that arrive while a round is in flight join exactly one follow-up.
- A preload that finishes while a round is in flight is always answered by a *later* round. That matters, because
  the earlier round may predate its decode.
- `_ssBusy` / `_ssNext` hand over in order: the clear of round n runs before round n+1 sets itself.
- A failed or short reply warns once (deduped by message) and still resolves.

Stale `_loaded` across a core restart can't happen within a page. An audio restart keeps the core cache (contract
6.6), and a lost socket is a page reload (ws-transport, no reconnect), which builds a new shim. The remaining stale
case is eviction, which the builder documented: a stale `true` makes a GO take the 1.x direct path, which is
acceptable.

A small imprecision: the core reports per patch, so a sampler with some samples failed and others not decoded reads
`failed` and therefore "ready". The web engine checks each sample. This case is rare and harmless.

**R4 (note, O-AW-3).** I traced these paths:
- absent + PC on → `'switch'` (controller PC handler and Settings);
- off → on writes `'cue'` in the same change;
- a stored choice is never overwritten;
- import of a 1.x library (replace) keeps the action absent, so it stays `'switch'`;
- `migrate` / `normalizeSettings` never fill the action in;
- the only writers of `programChange` are Settings' `tog` and `store.set`.

Toggling PC off and on turns a 1.x user into `'cue'`. That is the letter of O-AW-3, and Settings shows "Cue" while PC
is off, so it is not silent. I would still mention it in the 2.0 release notes.

**R5 (note, S7).** I checked these with a browser probe on the web engine:
- an Enter with a `role=dialog` open on Perform and nothing focused does not GO;
- with Settings open it does not GO (`body.settings-open` set, and cleared again on Esc);
- with neither, it GOes;
- main.js's Enter guard is registered before `controller.start()` adds its document listener, so the
  `preventDefault` arrives first.

The controller's `body.settings-open` check is a second guard: main.js's `popupOpen()` (which includes
`settingsOpen`) already blocks it. So S7 doesn't hang on the class alone.

One thing is not verified. A *held* Enter on a focused chip: the first press cues, and an auto-repeat would be a
second activation, so a GO. Playwright's repeated `keydown` produced no click, so this could not be reproduced.
Real keyboards may behave differently. If it matters, the chip should ignore `ev.repeat` for Enter.

**R6 (note, S8).** The timers are clean:
- the warm cap is cleared on settle and on dispose;
- a GO on a cold song holds two 30 s timers, both cleared;
- a capped warm-up is re-asked by the next cue or GO;
- dispose leaves 0 timers (unit-tested).

**R7 (observation; owner core, not Lane S).** I saw this in 1 of 3 probe runs. After library browsing filled the
cache to its cap (decodedMB 699.9 / capMB 700), I made the 8-song set current. One pinned song (Rhodes) was still not
decoded 1.5 s after `status.ready`: pinnedMB 420.5 < setMB 448.6. A direct `get sampleStatus` confirmed it. The shim
reported this correctly (chip "not loaded", and a GO waited 26 ms for the warm-up). The core apparently deferred a
pinned decode instead of evicting unpinned buffers. Worth a look in the cache lane.

**R8 (note).** The themes suite rewrites its `coverage-*.json` files on each run. After this run the builder's
content edits to `coverage-ember.json` are gone again, and every file differs from HEAD only in `generated`. This is
not a defect, because the suite passes on either content. Commit whatever the last run wrote.

### Fixed here

- `app/js/engine-bridge/bridge-engine.js`: `reloadManifests()` re-asks sampleStatus for known samplers (R1).
- `app/js/controller.js`: `warm()` publishes nothing after dispose (R2).
- Tests: `test/unit/engine-bridge/sample-status.test.mjs` (+1), `test/phase1/shell/cue-go-recheck.test.mjs` (new,
  1).
- `native/docs/SHELL.md`: G5 (the shape is settled; how the shim polls; the numbers) and G8 (the extra `get`
  traffic).
- `CONTRACT_CHANGES.md` "## Lane S": a "Re-check fixes" bullet.

### Still open

- The core should emit `load {phase:'samples'}` (O-AW-4, after CORE3). Once it does, the shim's polling becomes a
  fallback only. **Done by lane F1 (2026-11-25)**: per preload, per prepare, per pin re-warm pass; the shim's
  fallback stays and re-asks an id whose event overlaps a round in flight (CONTRACT_CHANGES "Lane F1").
- R7: a pinned decode deferred at the cache cap (core). Lane F1: the re-warm pass that later decodes it now sends a
  `samples` event, so the chip turns "ready" without another preload. Why the decode was deferred (pins not
  evicting unpinned buffers at the cap) is not changed and still wants a look in the cache lane.
- R5: Enter auto-repeat on a chip (unverified).
- From the first review: S9, and the D6 visual pass (GO name truncation, a dot legend).
