# Review round 4: controller (controller.js, midi.js, store.js)

Reviewer: cloud C6 review4 (controller). Scope: `app/js/controller.js` (mtime 16:24, before the C7 menu-bar edits),
`app/js/midi.js`, `app/js/store.js` (C7 menubar-A was editing store.js during the review; store line numbers are from
the 18:07 copy). Focus areas: today's L-3, L-8, the selectSong retry, the revert snapshots, pedal, velocity and pickup,
Web Locks secondary mode, save retries, preload-vs-switch races, state after a restart, and stage stalls or
double-fires.

Baseline: `node test/phase1/shell/run.mjs` PASS on this box (unit 153/153, browser 13/13, electron 14/14, no re-runs).

Experiments (node:test, fake or model engines, all runnable) are in
`/tmp/claude-0/-home-claude/7e62a35d-8374-53c8-b5e9-fdad80c27279/scratchpad/review4-controller/`:
`e1-pins.test.mjs` (L-8 pin plans), `e2-secondary.test.mjs` (takeover), `e4-restart-switch.test.mjs`
(restart with a switch), `e5-misc.test.mjs` (panic/swell, drone key after takeover, footswitch), `e6-store.test.mjs`
(H1 lock). Each assert states the correct behaviour, so the failing asserts are the confirmations.

Sizes used in E1: the Mac soak's decoded sizes from CONTRACT_CHANGES "## l8" (Salamander 333, upright 421, Rhodes 93,
clav+wurli 95, music-box+celesta 90 MB). Guesses use `BufferCache.estimateBytes` with nothing decoded:
1.75 MB × the manifest note count, so Salamander 158, upright 121, Rhodes 140, clav/wurli/celesta/music-box 154 each.

## Findings

| # | Sev | Where | Problem | Fix | Status |
|---|---|---|---|---|---|
| C1 | major | controller.js:1328–1348, 1380–1383, 1394–1403 (engine/audio.js:1580–1597) | **After a restart, an overlapping switch keeps the old song's transpose, tempo and drone key.** `engine.restart()` → `applyState()` prepares and commits the patch it captured, then applies that song's routing, transpose, tempo, key context and drone *whatever its commit returned*. When a song switch's prepare resolves before applyState's prepare, the switch commits (the controller applies B's song level), applyState's commit is refused as stale, and then its tail writes A's transpose, tempo and key over B. `afterRestart()` re-sends the pedal, wheels, mono and pads, but never the song level. E4 (token model of the engine): the engine ends with B's patch, transpose 2 (want −5), tempo 70 (want 140) and drone key D (want G). Triggers: Restart sound, the watchdog auto-restart, a latency change, or a `setSinkId` fallback, with Next or a program change inside the same ~100 ms. | In `afterRestart()` (so both restartAudio and onEngineRestarted get it): `if (applied) { lastDroneKey = null; applySongLevel(applied, null, true); }`. If `targetId !== appliedId`, the pending switch's commit applies the level anyway. Engine owner (frozen, report only): applyState should skip its routing/transpose/tempo/key/drone tail when `commit(tok) === false`. | CONFIRMED (model) |
| C2 | major | controller.js:737–745 (and 747–749) | **Setlist mode pins the whole set on a guessed size.** `preloadSetlist()` compares `est.mb` with PIN_BUDGET_MB without looking at `est.exact`, then `pinSongs(ids,'replace')` decodes and pins everything. The downgrade to large-set only happens after the whole set is decoded and pinned. L-8 closed this hole for window neighbours (`onlyExact`) but not here. E1d: launch with the setlist [grand-piano, prayer-wash, upright-pad, building-swell] (current song exact 333 + upright guessed 121 = 454 ≤ 600) pins **754 MB > 700 cap**. `updateMemory()` then fires the cap warn, which is toasted (see C5). The same happens on every setlist switch to such a set, and again on every launch, because `BufferCache.sizes` is in memory only. With the Linux sizes it stays under the cap but goes over the budget (e.g. + Rhodes = 662). | Pin whole only when `est.exact`. Otherwise run the large-set path first: an exact-only window, then warm the rest unpinned nearest first under the 80 % cap share. Then re-estimate, and upgrade to `pinSongs(ids,'replace')` only if the estimate is exact and ≤ budget. | CONFIRMED (model, Mac sizes; Mac run requested below) |
| C3 | major | controller.js:636–641, 686; 492 + 672 (winSeq) | **The window is planned around a current song that is still loading, priced at its guess.** `planWindow()` checks `exact` only for neighbours. The current song (`settings.currentSongId`) is taken at face value, so when a plan runs while a switch is still preparing, the target is priced at its guess. `winSeq` only moves on commit (`preloadNeighbors`), so an older window's phase-2 re-plan (686), or a `preloadSetlist()` from a nav edit or a setlist change (onStore 1738), plans around the loading song. E1b (setCurrentSetlist whose first song is the undecoded upright): **849 MB** pinned. E1c (a nav edit during a jump to upright-pad): **849 MB** (upright + clav-funk + gospel + anthem). E1a (phase 2 of the previous window finishing mid-switch): 606 MB > budget. The next commit's replace repairs it, but the whole decode sits over the cap. | In `planWindow({onlyExact})`, treat an inexact current song like a guessed neighbour: pin it alone and move the candidates to `guessed`. Run the phase-2 re-plan with `onlyExact: true` too, and skip any candidate that is still inexact. Bump `winSeq` at the top of `selectSong()`, so no older plan re-plans while a switch loads. | CONFIRMED (model) |
| C4 | major | store.js:1065–1071 (setReadOnly); controller.js:1811–1826 | **A second-window round trip drops the H1 'backup-failed' lock, and the unreadable library is overwritten.** `setReadOnly(true,'second-window')` replaces the reason, so the takeover's `setReadOnly(false)` finds 'second-window' and clears it. `reload()` keeps the current (seeded) state when storage is unreadable, so the next persist writes over the only copy. E6: the reason goes `backup-failed` → `null`, and `rig.v1` is rewritten with the seed. In Electron, `secureUnreadableLibrary()` (run by startPrimary) saves the raw copy to disk first. **In Chrome the only copy is lost silently.** It needs a corrupt library, a failed backup (quota) and two windows, so it is rare, but it breaks a safety invariant. | `setReadOnly(on)`: never replace 'backup-failed' (`if (readOnlyReason === 'backup-failed') return false;` when turning another reason on). Or keep a set of reasons and clear only the one passed. | CONFIRMED |
| C5 | minor | controller.js:585–588 (+ main.js:655–659 renders it) | **The cap warn is developer text, toasted on stage.** `warn('pinned samples 754.0 MB exceed the 700 MB cache cap (large-set; L-8)')` goes through `'warn'` → `plainToast` → `plainMessage` passes it through verbatim. With C2 and C3 it fires on real launches and switches. Nothing in the UI reads the song-alone `'memory'` event either. The soak only reads `status.memory` (soak.mjs:431), not the warn. | Emit the cap crossing as `console.warn` + `emit('memory', {…, overCap:true})`, not `'warn'` (or tag `source:'diag'` and have main.js skip it). The toast, if kept, should be plain copy such as "This set is using a lot of memory; songs load as you go." | CONFIRMED (reading + E1d output) |
| C6 | minor | controller.js:1818–1825, 1869, 1731–1738 | **Takeover (secondary → primary) replays the reload diff into a half-started controller.** `store.reload()` queues its notification, and `startPrimary()` subscribes `onStore` in the same tick, so the reload paths arrive while `engine.start()` is pending. `onSetting('latency')` → `restartAudio()` → `engine.restart()` runs *before start() resolves*, and onStore's `selectSong(cur)` prepares a first time before startPrimary's own selectSong prepares again. E2: the call order is `start prepare restart commit … prepare commit …`, and a "Sound restarted." toast fires. The real engine's restart tears down the context that `_start()` is still initialising. The C7 device-local settings (menuBarMode, lowResource) will ride the same path. | In enterSecondary's `.then`: `store.reload(); store.flush?.();` **before** `startPrimary()` (no listener yet, so the diff is dropped; startPrimary applies current settings itself). Or ignore onStore until startPrimary has passed `selectSong`. | CONFIRMED |
| C7 | minor | controller.js:303–313, 1811–1826 | **A song tapped in the secondary window leaves `lastDroneKey` set, so takeover never sends `drone.setKey`.** In secondary mode `droneCall` is a no-op, but `applyDrone` still records `lastDroneKey`. After takeover, if the current song has the same key, `setKey` is skipped and the fresh engine's drone stays in its default key. E5b: no `drone.setKey` after takeover (want pc 9). | Reset `lastDroneKey = null` (and `applied = appliedId = null`) when leaving secondary. Or set `lastDroneKey` only when `droneCall` actually ran (`!secondary`). | CONFIRMED |
| C8 | minor | controller.js:1177–1188 (engine audio.js:1491) | **Panic during a swell: the next Swell press does nothing.** `engine.allNotesOff()` sets `_swell = null`, but the controller's `swellActive` stays true. The next toggle (Perform Swell button / Shift+↑ / learned swell) sends `swell(false)`, which the engine ignores. E5a: `swell()` → false, `[['swell', false]]`. | In `panic()`: `swellActive = false;` (also clear `buttonState` — already done). | CONFIRMED |
| C9 | minor | controller.js:868–880 | **Learned CC buttons are level-triggered on `value ≥ 64` with a held state.** A toggle-mode footswitch (127/0 alternately) advances once per two presses, and a press-only switch (127 each press) works once, then never until a value < 64 arrives. E5c: 4 toggle presses → +2 songs; 2 press-only messages after that → +1. | For CC buttons (not swell), fire on every `value ≥ 64` that arrives ≥ ~150 ms after the last fire, and treat `< 64` as release only. Or learn the mode: if the first two learn-time messages are both ≥ 64, mark the mapping `trigger`. | CONFIRMED (behaviour); whether Ryan's pedal sends this is SUSPECTED |
| C10 | minor | controller.js:1906–1909 | **start() walks the pad folder before loading the first song.** Electron awaits `rig.listPads()` (a sleeping external drive can take seconds to spin up). Chrome awaits the IndexedDB handle + a `for await` directory walk with `getFile()` per file. Both run before `selectSong(cur)`, which delays first sound and `__rig.ready`. | Select the song first, then attach pads. `restorePads`-style re-apply (`lastDroneKey=null; applyDrone(applied,null,true)` when `applied.drone.mode==='files'`) covers a files-mode first song. | SUSPECTED |
| C11 | minor | controller.js:504–515 | **revertSong() during a switch reverts the previous song.** `selected` only moves on commit, so while B is loading, Revert (and the changed-dot baseline) targets A while the views show B. | Return false (or no-op) while `targetId !== selected.id`, or snapshot on 'song-loading'. | SUSPECTED |
| C12 | nit | controller.js:761–785 | Large-set warming keeps warming around the position it started from after later switches (only `preloadSeq` stops it, not a switch). It decodes songs farther from the player than needed and competes with the next song's decode. | Also stop the loop when `winSeq` moved (or restart it from the new position). | SUSPECTED |
| C13 | nit | controller.js:1818–1826 | A controller disposed while secondary still gets the lock later. The callback holds it forever (`!started` returns, but the lock promise never resolves), so another window can never become primary. Only reachable with dispose() in the page (tests). | When `!started`, call `releaseLock()` before returning. | SUSPECTED |

## Checked and solid

- **L-3.** `start()` doesn't await MIDI. The soft timer is cleared on settle and keyed by `midiGen`. The timeout
  callback checks `midi.available`, which is set synchronously before `init()` resolves, so a grant can't race it into
  'pending'. A denial clears `pending` through `'unavailable'` before the `'devices'` event, which keeps `reason`. A late
  grant clears both through `'devices'` (`available:true`). The midi-l3 tests and the browser test cover this. The only
  nit: `select()` also runs after a denial, so status shows `fallback:true` with no ports. That's harmless.
- **The selectSong commit-refused retry.** It retries once. The retry supersedes nothing newer, because `my === seq` is
  checked before commit. The second refusal restores the exact setlist entry (`appliedIndex`). A first-song failure
  keeps the target (round2-shell #10). reprepare has the same retry.
- **Latest-wins.** Shared `seq` between selectSong and reprepare. `repreparing` is cleared by selectSong. Edits made
  while loading are caught up after commit (`catchUp`). onStore only diffs when `cur === appliedId === targetId`.
- **Snapshots.** 'songSelected' is taken after catchUp (round2-shell #4). The generation bump refreshes `selected` on
  import-replace and on reload. revertSong's multiple `store.set`s are batched into one onStore (microtask flush), so no
  intermediate transpose reaches the engine. `transposeOctave` is clamped individually, so each write is accepted.
- **L-8 atomicity.** One `setPins` per replace. `lastPin` re-application covers out-of-order completion. 'add' stays
  within the replace. Pin states during a plain walk are within budget (the shell tests hold). The problems are only the
  guessed-size entry points (C2, C3).
- **Pedal.** Per-input raw state, and pedalInvert re-apply may only release (L9). Disconnect or deselect releases that
  input's notes and pedal. Panic clears pedal state, and the engine's allNotesOff drops sustain (`pedal=false`). A
  restart re-sends a held pedal. A pedal pressed or released during the restart ends right, because `sustain()` is
  ignored while `fx` is null and afterRestart re-sends the final state.
- **Notes.** Per-source ref counting (MIDI `input:channel`, kb, ui), duplicate note-on ignored, CC120/123 per channel,
  window blur and hidden release the computer keyboard, keyup always releases (even when focus moved into a text field).
- **Velocity and pickup.** `applyVelocitySens` clamps and 'fixed' → 100. Pickup is cleared on commit and on learn. The
  taper round-trips exactly (`cbrt(2p³/2) = p`), so a picked fader doesn't unpick itself. All learnable faders are
  0..2 lin, matching the taper.
- **Double-fire.** Electron's ⌘←/→ are `registerAccelerator:false`, so only the keydown handler fires. Key repeat is
  ignored for navigation, panic and swell. Learned note buttons edge-trigger on note-on/off. Perform buttons blur
  after a pointer click (main.js:720), so Space stays the sustain pedal.
- **Store saves.** Debounce + idle, retry backoff 1/5/30 s that repeats, the persistError toast only on the transition,
  'library-saved' on recovery, and a read-only store keeps `dirty` and writes on release. pagehide and hidden flush
  synchronously. The secondary window never writes (checked on the write path, so a seed-time timer is safe).
- **restartAudio.** `restarting` guards re-entry and the watchdog. An engine-emitted 'restarted' during our own restart
  is ignored. A rejected restart leaves 'stalled'. The recorder's stop is bounded (1.5 s), so a take can't hold the
  restart.

## Prioritised fix list

1. **C1**: re-apply the song level in `afterRestart()` (3 lines). This is a wrong key or tempo on stage. Add a
   controller.test with a model engine like E4.
2. **C2 + C3**: exact-only pins everywhere (the setlist whole-pin, the current song in `planWindow`, the phase-2
   re-plan) and a `winSeq++` in selectSong. Add memory.test cases E1a–E1d, using the guessed-size engine from
   `e1-pins.test.mjs`.
3. **C4**: `setReadOnly` must never clear 'backup-failed' (1 line + a store test like E6).
4. **C5**: take the cap crossing off the toast path (console + 'memory' event). With 2 done it should be rare, but when
   it happens the copy must not be developer text.
5. **C6 + C7**: clean takeover. Flush the reload before subscribing, and reset `lastDroneKey`/`applied` when leaving
   secondary. The C7 menu-bar settings make C6 more likely.
6. **C8**: `swellActive = false` in panic (1 line).
7. C9, C10, C11 when convenient. C12 and C13 are nits.

## For LOCAL (please relay to reviews/for-local.md; this reviewer's scope was read-only except this file)

- **Verify C2 on the Mac** (upright's real size there is 421 MB per the l8 notes, but not verified). Before and after the
  fix: build or `npm start`, make a setlist **[Grand Piano, Prayer Wash, Upright Pad, Building Swell]**, select it, quit,
  relaunch. Record the max `__rig.controller.status.memory.pinnedMB` over the first 30 s (poll every 250 ms), and
  whether a "pinned samples … exceed the 700 MB cache cap" toast appears. Report `C2_MAC pinnedMax=<MB> toast=<y/n>`.

## Fix status (round4-controller fixer, 2026-09-28; details in CONTRACT_CHANGES "## round4-controller")

| # | Status | Test |
|---|---|---|
| C1 | FIXED: afterRestart re-sends the applied song level (drone only if restorePads didn't) | round4-controller.test C1 |
| C2 | FIXED: guessed setlist sized first (probeSetlist), pinned whole only when exact ≤ budget | C2 ×2; memory.test updated |
| C3 | FIXED: inexact current pinned alone; phase-2 onlyExact; winSeq++ in selectSong | C3 ×3 |
| C4 | FIXED: setReadOnly(on) never replaces 'backup-failed' | C4 |
| C5 | FIXED: console.warn + 'memory' {overCap, note: OVER_CAP_NOTE}, no 'warn' | memory.test "alone" |
| C6 | FIXED: reload + flush before startPrimary; engine.latency set before start | C6 |
| C7 | FIXED: applied/appliedId/targetId/lastDroneKey reset on takeover | C7 |
| C8 | FIXED: panic clears swellActive | C8 |
| C9 | FIXED for press-only switches (150 ms re-trigger); toggle-mode still every other press | C9 |
| C10 | not done (SUSPECTED) | |
| C11 | not done (SUSPECTED) | |
| C12 | not done (nit) | |
| C13 | FIXED: release the lock when granted after dispose | C13 |
