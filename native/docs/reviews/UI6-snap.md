# U-SNAP (D26.1 + D26.1a, snapshots remember Space / Echo / drone): skeptic review (2026-11-27)

Verdict: **VERIFIED, after fixes.** As delivered it was PARTIAL. The data model, old-scene compatibility, the scene
change's engine calls and the transient taps held up. Four defects: Save during an instrument load moved the whole mix
to the song before the load (F1, medium); v6 Edit's instrument strip wrote Space / Echo into the song under a snapshot
and a step equal to the song's own value was silent (F2, medium); the Effects panels' send controls in both Edit views
showed the song's own sends under a snapshot and snapped back after a tap (F3, low); the Save snapshot dialog's new key
choice was a 22 px control, failing the iPad touch rule (F4, low; the builder could not run ui-v6-ipad before the
rebase). Edit also gives no sign that its Space / Echo / drone controls edit the playing snapshot rather than the song
(O1, for Ryan).

Under review: lane-snap 62ca568..4cf3c43 (8 commits on v2-native 1cb4b8c, after the rebase): `shared/scenes.js`
(normaliser, capture / apply / merge / tweak / absorb, `sceneFieldOf`), `controller.js` (`sceneMove`, the stepped mix
glide, `scenes.take`, Save's chosen key, the bus / learned knobs / menu-bar state), the views (today's Perform, Edit v2
shell / drone, v6 song bar / strip / sidebar Drone / Edit drone / Save snapshot dialog) and the tests. I didn't build
it.

## What held

- **Data safety.**
  - A pre-D26.1 scene normalises to itself (unit + model tests), and a 1.x schema-1 library's scenes migrate exactly as
    before (4 entries, levels only). `migrate()` stays idempotent; junk in the new fields is dropped field by field,
    never coerced.
  - **Write → persist → reload → read** (my probe: real `memoryStorage`, `persistNow`, a second `createStore` on the
    same bytes): a scene with sends, `fx.reverb` / `fx.delay` rows, `drone.mode` and `drone.keyShift` and a name comes
    back deep-equal. `store.js` validates `scenes` only through `normalizeScenes` (whole-list writes, `migrate()`, slot
    re-orders, the Revert lineage), so no SCHEMA bump is needed and nothing drops the new fields.
  - Export / import (library and single song) round-trips; slot move / insert (`scenesFrom`) / remove and the Revert
    lineage carry each entry's sends with its instrument (the builder's tests, read and re-run).
  - Trial songs: a snapshot saved on a `trial:<n>` song (with a chosen key and a take on top) never reaches storage (my
    probe: the persisted library has no `trial:` song and the same song ids as before).
  - Patch-pack fingerprint: an untouched pack song normalises as before (the new fields are absent from songs saved
    before this build), so its fingerprint is unchanged; a Save counts as an edit, as any Save did.
- **Sound.**
  - A scene change sends no `prepare` / `commit` / `allNotesOff` / `noteOff` / `fadeOutAll` / `sustain`, and a held note
    stays held (builder's test, re-run; also true in every probe).
  - The drone key change is the key grid's path (`setKeyContext` + `drone.setKey`, the drone's own crossfade), the ON /
    sound change is the ON tile's `drone.configure` with the level held, and `setTranspose` is never sent: `playIn`
    moves with `hearIn`, so `transposeSemis` and the instruments' pitch never change.
  - **Easy Transpose under a chosen-key snapshot** (probe): song key +2 → the drone goes to song + 2 + 5 at once, no
    `setTranspose`; leaving the snapshot → the drone goes to the song's (new) key; a real transpose change (`playIn`
    only) under the snapshot sends one `setTranspose` and leaves the drone.
  - **Stepped glides** (probes, fake clock): a second scene change mid-glide starts from where the first glide is (its
    first step is below the mid-glide value and above the target, never a jump back); a step 2 s late (a throttled
    hidden tab) lands on the target and ends the glide; dispose leaves no step timer; an instrument re-prepare prepares
    with the scene's target and no step comes after its commit; a song switch mid-glide: steps go on while the new song
    loads (the old one still plays), none after its commit. The Electron main window has `backgroundThrottling: false`;
    only the Chrome fallback can be throttled.
- **Transient taps.** `scenes.take` under a snapshot for `songs.<id>.patch.slots.0.sends.reverb`,
  `slots.0.sends.reverb`, `song.patch.slots.0.sends.reverb` and `fx.reverb.size`, each with **the song's own value**:
  heard (the engine gets it), nothing written (`store.get()` is the same object). A whole unit the snapshot holds only
  partly goes to the store, as documented. Save / Update keep a take and the next scene change drops it (builder's tests
  + ui-v6 snap tests, re-run).
- **No snapshot playing: views write the song exactly as before.** A scripted session through the real UI on the base
  build (1cb4b8c, `git archive`) and on lane-snap, fresh library each:
  - flag off: Space row Hall, Echo row Dotted, key grid, Minor, drone ON tile twice, Edit v2 › Effects send chip,
    Effects › Space Stage, the Keys panel's Echo chip, the Drone panel's tile: 21 store write paths;
  - flag on: song bar Space Hall, a strip's Space step, sidebar Drone key / Minor / ON, v6 Edit › Effects Stage, v6
    Edit's strip Echo step: 14 write paths.
  - Both: the libraries are **byte-identical** (song ids numbered by order) and the write paths identical, 0 console
    errors, 0 HTTP ≥ 400 (script: `/home/claude/scratch/snap-skeptic/bytecmp.mjs`, not committed).
- **Changed dots / Revert.** Under a snapshot a take writes nothing, so neither Perform's nor Edit's dots
  (`ctx.getBaseline`) light; a fallback store write (absorbEdits) is a song edit in both. They agree.
- **MIDI learned knobs and the bus.** A learned knob on a send or a Space / Echo row picks up against the song as it
  plays (`learnedFader` reads `live()`), then goes on top of the snapshot (`SCENE_LEVEL_RE`); `droneToggle` / `droneKey`
  read and take the drone as it plays; `menuBarState().droneOn / droneKey` are the heard drone, `key` the song's own.
- **Native.** No engine API is new: a scene change makes `setParam` (PARAMS paths only; `glide` only on `slots.<i>.gain`
  / `drone.gain`), `setKeyContext`, `drone.setKey`, `drone.configure`. `bridge-engine.js` accepts every one (its
  `_validPath` is `isValidPath` plus slots 4..15). `app/js/engine`, `app/js/engine-bridge`, `native/core` and the golden
  fixtures are untouched (`git diff --stat` empty).

## Findings

- **F1 (medium) Save during an instrument load moved the whole mix to the song before the load.**
  - `saveScene` ended with `sceneMove(heard, live(applied))`. During a re-prepare `applied` is still the song as it was
    before the load, without the scene just saved, so `live(applied)` was that song's own sound.
  - Measured (fake engine, slow decode): scene 1 = Hall + Dotted Eighth, Keys' send 0.7; a live move Keys 0.33 on top; a
    new Keys instrument loading; Save as new. The save sent the room / echo back to the song's own (7 `setParam`s,
    `fx.reverb.size` 0.65 → 0.62 …), glided Keys 0.33 → 0.8 and stepped the sends / returns down, while the row said the
    new snapshot played. The commit's catch-up put it back. An Update did the same towards the old scene.
  - Fix (1d6c682, `controller.js`): `sceneMove(heard, live(saved))`: only a key chosen in the dialog moves anything.
  - Test: `scene-snap-review.test.mjs` "UI6-snap F1" (fails before: the room / echo rows, Keys' level and the sends are
    all sent where nothing should move).
- **F2 (medium) v6 Edit's instrument strip wrote the song under a snapshot.**
  - The strip in v6 Edit's instrument block is Perform's `strip.js`, but its view context (`views/v6/edit/edit.js`
    `stripV.setSlot`) wrote `store.set` directly, unlike v6 Perform's `setSlot`. Under a snapshot that holds the send, a
    Space / Echo step edited the song (heard only through the absorbEdits fallback), and a step equal to the song's own
    value changed nothing in the store, so it was silent while the strip showed the snapshot's value.
  - Fix (4dd5f2d): `controller.scenes.take` first, as v6 Perform.
  - Test: ui-v6 "UI6-snap F2/F3" (snapshot holds Keys' Space 0.9, the song's own is 0.25; the strip's 25 % step is heard
    and the song is not written). Fails before at the engine check (the send stays 0.9).
- **F3 (low) Edit › Effects' send controls showed the song's own sends under a snapshot.**
  - Edit v2 › Effects' send chips (`panels/effects.js`) and v6 Edit › Effects › Sends (`v6/edit/effects.js`) bind with a
    custom `read` of the song, so the shell's "scene fields read `ctx.view()`" never applied to them. Under a snapshot
    they showed the song's value; a tap went on top of the snapshot (heard) and the control snapped back.
  - Fix (4dd5f2d): both reads use `ctx.view()`.
  - Tests: ui-core "UI6-snap F3" (the chip says 90 %, then 25 % after leaving the snapshot) and the ui-v6 test above
    (the cell's `aria-valuetext` says 90 %). Both fail before.
- **F4 (low) The Save snapshot dialog's drone key choice was 22 px tall.**
  - The D26.1a `<select>` in "It keeps" had no style (238 × 22 px at 820 × 1180). ui-v6-ipad's 44 px touch check failed
    in "Save snapshot fit both ways", and the dialog it left open failed the next three tests (24/28).
  - Fix (1afc24d, `styles-v6-dialogs.css`): `.v6-keeps-key` / `.v6-savesnap-key`, a 44 px control in the dialog's look.
    The lane's "no CSS change" no longer holds (this one block, flag on only); CONTRACT_CHANGES D26.1 says so.
  - Test: the existing ui-v6-ipad fit checks (24/28 before, 28/28 after).

## Open items

- **O1 (for Ryan / design) Edit doesn't say it is editing the snapshot.** Under a snapshot, Edit's Space / Echo / sends
  / drone controls show and change the snapshot (transiently, as Perform), not the song: no changed dot, Revert does
  nothing to them, the next snapshot change drops the change and only Update keeps it. Neither Edit v2 nor v6 Edit shows
  which snapshot plays (Edit v2's Song panel lists scenes; nothing near the controls). Someone shaping a song in Edit
  while a snapshot happens to play will lose those edits. Suggest a line in Edit's header while a snapshot plays
  ("Snapshot “Hall” plays: Space, Echo and drone changes go to it. Update to keep them."), or leave the snapshot on
  entering Edit. Not changed here (a UX decision).
- **O2 (low, cosmetic) Some summaries still read the song's own sends:** v6 Edit › Effects' Sends category line ("N of M
  in the Space") and the instrument block's "Space & Echo" category line (`categorySummary` on the song's slot). The
  controls themselves are right after F3.
- **O3 (low) A Save during a load still makes redundant calls at the commit.** R-2's catch-up diffs against the song as
  the load started (without the new scene), then `catchUp` sends the saved scene: in one task Keys gets `glide → 0.8`
  then `0.33`, `fx.reverb.size` `0.62` then `0.65` (the reverb swap is debounced, the plain set ends the glide). Net:
  what was heard. Pre-existing for levels (v11 R-2); D26.1 adds the fx rows.
- **O4 (low) Downgrade.** A library saved by this build and opened by a build before D26.1 (an older Mac app, a backup
  imported there) drops the new scene fields and so changes a pack song's fingerprint there (it reads as edited). No
  corruption; usual for a new optional field.
- **O5 (copy) Save snapshot's row "The drone: ON / OFF, sound and level, and its key"** while the key choice below
  defaults to "Follows the song’s key": the row title reads as if the key were pinned.
- **O6 (accepted)** A hidden Chrome-fallback tab steps at ≥ 1 s, so a glide there ends in one step (τ 15 ms smoothing)
  at the first step after 0.5 s. The Mac app is not throttled.

## Not verified

- How it sounds: no listening, no offline render of a scene change on the web or native engine (fake engine and the web
  engine's `getParam` only). The native core's handling of these `setParam`s (reverb swap, delay lines) was not run.
- Real Mac / iPad, a MIDI controller, the menu-bar popover on the Mac, the Electron suites.
- Chrome's real hidden-tab timer behaviour (the clock-based step was tested with a fake clock).
- The Save snapshot dialog's look (no screenshot review); O1 was judged from the code (no indicator element exists).

## Gate

The box had 2 CPUs, shared with another skeptic's suites (wt-u8b); I waited for them and ran mine one at a time.

| suite | result |
|---|---|
| shell unit (`test/phase1/shell/run.mjs --only unit`) | **404/404** (397 + the 7 review probes) at 4dd5f2d |
| unit (`test/unit/**`) | **685/685**, 12 skipped (as before) |
| ui-core | **78/78** (scenes.mjs 8/8 with "UI6-snap F3"; fails before) |
| ui-v6 | **82/82** at 4dd5f2d and again at 1afc24d; flag-off purity vs 1cb4b8c identical; "UI6-snap F2/F3" fails before (F3 and F2 checked separately) |
| ui-v6-edit | **37/37** at 4dd5f2d (flag-off purity, Edit too, identical) |
| ui-v6-ipad | **24/28** at 4dd5f2d (F4), **28/28** at 1afc24d |
| ui-v6-bank | **21/21** |
| edit-v2 | **14/14 files** |
| settings | **111/111** (app, fixture, mac, bridge, v6) |
| migration-1x | **107/107** unit + **8/8** browser |
| scripted byte-compare vs 1cb4b8c | identical libraries and write paths, flag off and on |

0 console.error and 0 HTTP ≥ 400 in every suite and probe. ui-core, ui-v6-edit, ui-v6-bank, edit-v2, settings and
migration-1x ran before F4 (a v6 dialog CSS rule); ui-v6 and ui-v6-ipad ran again after it.

Lane tip: the commit adding this review, on 1afc24d (lane-snap; not pushed or merged).

