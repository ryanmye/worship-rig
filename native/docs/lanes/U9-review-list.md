# U9: open questions for Ryan (his Mac review of the new layout and the 2.0 release)

Gathered by Lane R on 2026-11-27 from every `native/docs/reviews/UI6-*.md` open item and every DECISIONS entry
addressed to Ryan, at `v2-native` d35b788. Deduplicated: an item a later decision or lane already settled is not
listed as open; those are in "Already answered" at the end, so nothing is asked twice. Each item says what is built
now (the default if Ryan says nothing) and where it comes from (`file` › section / item).

Skeptic pass (2026-11-27, `native/docs/reviews/LaneR.md`): items 6, 8, 25 and 27 turned out settled and point to
"Already answered" (their numbers stay, so references hold); items 51–54 were added in their sections.

How to use it: turn on **Settings › Look › Perform view › Try the new layout (preview)** on the Mac, go screen by
screen, and answer each item with **keep**, **change to …** or **later**. The release checklist
(`native/docs/MAC_CHECK.md` "2.0 release checklist") has the hardware checks; this list is the design calls only,
plus the release-scope questions in section 1.

## 1. Release scope (tier 1: before 2.0 can ship)

1. **MIDI keyboard input in the Mac / iPad app** looks unwired (Lane R code read, not run): WKWebView has no Web MIDI,
   the JS polyfill over the native `midi` op is not built (ENGINE_CONTRACT §5, WEBKIT_AUDIT item 5), and `RigMIDI`
   connects only the sources a `midi listen` op names, which nothing sends. Not a design call: it has to work before
   release. Being built on lane-nma; nothing to answer unless that lane stalls. (MAC_CHECK "2.0 release checklist"
   B1)
2. **Ship 2.0 without these in the Mac / iPad app?** My Samples, patch packs and the Song bank's content, the
   GarageBand importer, My Pads (pad folder), menu-bar mode, Open at login, global shortcuts, the update check, MIDI
   clock out (rides on B1), keeping the screen awake (1.x holds `powerSaveBlocker`), and most of the 1.x Rig / Help
   menus (the app has File › Import Library Backup… only). They work in Chrome and / or the 1.x app. Options: (a) ship
   and list them as known gaps (the release notes draft does); (b) build some first (which?). Asked by the
   orchestrator on 27 Nov. (`RigSchemeHandler.swift`, `RigLibrary.swift` polyfill, `WorshipRigApp.swift`, SHELL.md
   "Later tasks")
3. **Intel Macs and macOS 12–14.4.** The 2.0 app is arm64-only and needs macOS 14.5 (`project.yml`,
   `build-core.sh`). 1.1.x's update check reads GitHub's latest release, so once 2.0 is "latest" every 1.1 user is
   told about it, including the ones it can't run for (on Intel it finds no `x64` file and opens the release page).
   Options: (a) accept, with "Intel or older macOS: use 1.1.1" on the release page and the site (drafted);
   (b) also ship a 1.x-shell Electron build of 2.0 for them (plays 4 sounds, no native engine); (c) publish 2.0 as a
   pre-release first, which the update check skips. (`update-check.js` `pickAsset`, release.yml comments)
4. **Is the Electron app retired in 2.0?** `npm start` / `npm run build:mac` on `v2-native` still build the 1.x shell
   with the 2.0 screens and the browser engine (4 sounds). The README now calls it "the 1.x app (Electron)". Keep,
   or remove after 2.0? (README "The 1.x app (Electron), from this folder")
5. **The native release build.** There is no workflow or script that builds a Release `Worship Rig.app` from
   `native/apple` and packs a `.dmg` / `.zip`; `release.yml` builds Electron. The checklist drafts the steps (asset
   names kept as `Worship-Rig-arm64.dmg` / `.zip` so 1.1's update check finds them). Who builds it: Ryan's Mac by hand,
   or a new CI job? (MAC_CHECK "2.0 release checklist" steps 2–3)
6. *(Settled: desktop Auto stays 128, D5 follow-up. See "Already answered".)*
7. **Should PANIC also stop the song's drone?** Since 1.x it deliberately leaves a drone the song has on; since UI6-er
   it stops a drone no song wants. Asked by the orchestrator on 27 Nov. (UI6-er O1; UI6-build-plan "Empty-library
   silence")
8. *(Settled: PDF charts and notation come after 2.0, D33. See "Already answered".)*

## 2. Perform (new layout)

### Strips and the stage

9. **16 instruments: the name pills.** At 16 the pills shrink to "W…" stubs, the "16 instruments · scroll" hint is
   cut, and at 820 / 1180 px the last pill is past the edge (the strips still scroll to it). Options: let the pills
   scroll, or shrink them further from about 12. (UI6-U1 O5; UI6-U8a O2)
10. **Builder choices on the strips' order and grip** (all built as listed): the ⠿ grip drags at once on touch (no
    long-press); a cancelled live range drag writes the old value back even under Lock; a move drops a range pick
    instead of following the instrument. (UI6-move O1)
11. **MIDI Learn mappings stay with the position**, so a learned knob keeps moving "strip 1" after a reorder. Revisit
    if knobs should follow an instrument. (DECISIONS D23.2; UI6-U7c, the note on O-AW-ML rule 2)
52. **The Start here band hides while Learn or Arrange is on** (their own bar is the instruction then; it comes back
    on Done). The other option was a smaller panel under the strips (about 140 px). (UI6-U8b, "For Ryan" under F3)
12. **Perform's Change** still switches to Edit to open the chooser. The orchestrator's answer (open the chooser
    over Perform, D14 "single sound at the desk") is queued, not built. Confirm. (UI6-build-plan "Polish (U5b open
    Q4)"; UI6-U5b builder choices)

### Song bar and snapshots

54. **"you play C" sits in the song bar** beside the key (built). D16 left it open ("proposed, not yet drawn").
    Keep? (DECISIONS D16 "Still open")
13. **Empty current setlist wording.** With an empty setlist the sidebar title says "Library" and lists every song,
    while + Add song says "add one to ‘Empty set’"; a New song then makes it a one-song setlist without the playing
    song ("Empty set · 1 songs"). (UI6-U3 O2)
14. **Snapshot naming and Update** (built): the suggested-name heuristic (instruments on, louder / softer, drone
    up / down); Update keeps the old name unless the field was edited; Rename is refused on a trial song ("Keep it
    first"). (UI6-U7c O6)
15. **Save snapshot's drone row** no longer says "and its key" (the key choice below defaults to "Follows the song’s
    key"). Check the dialog's words read right. (UI6-snap O5, changed in the U-SNAP follow-up)
16. **Delete's hold text** doesn't say the song leaves every setlist (Edit's confirm does). (UI6-U7c O4)

### Left panel and Quick

17. **The Quick sheet covers the top of the keyboard at 1280 × 800** (51 px; with Start here showing, C2 to about C5).
    Capping it above the keyboard would push "Hold to restart the sound" behind a scroll. (UI6-U8b O1; UI6-U4 known)
18. **Quick builder choices** (built): the sheet is anchored to its opener (beside the left button, under the top
    bar's); one header line (subtitle, or the Lock line while locked); "Warm Pad level" / "Instrument n level"; the
    wheel caption hides below 760 px tall windows; Save as scene 1 · 2 · 3 kept in the sheet. (UI6-U4 O4)

### Right sidebar

19. **Sidebar builder choices** (built): New song from the setlist is added at the end and not selected (D24.4
    confirmed that part); the pad-folder line shows only for My Pads; "Starts open / collapsed" applies per page load;
    the song bar's Notes / Setlist un-hide a module the player had hidden. (UI6-U3 O7)
53. **D16's Tone and Snapshots sidebar modules aren't built.** The sidebar has Drone, Setlist, Notes, Click and Chart;
    snapshots have their own row under the song bar and tone is in Edit › Tone EQ. Want either as a module, and
    "Snapshots also in the top row" from the mockup's customize? (DECISIONS D16; UI6-U3 O5)
20. **Width memory:** ← / End at the widest point of a small window saves the clamped width over a wider one saved on
    a big screen; a drag-fold makes the default width explicit. Both follow "the player moved it". (UI6-U3 O3)

### Range bars and the keyboard

21. **Range builder choices** (built): lowest must be below highest (today's Edit allows a one-key range); the
    finishing tap on the keys plays no note, now on every pointer, Mac included; past the keyboard's edge means "every
    key that way" (A0 and "every key down" are 7 px apart on Perform, 3 px on the 88 keys). (UI6-U2 O1; UI6-move O1)
22. **A muted instrument's range bar keeps its colour** in the new layout (today's keyboard greys it; the number goes
    grey with colour-blind colours on). Fix = one CSS rule, which changes v6 pixels. (UI6-fu2 O1)

### Chart

23. **The chart's look as a whole** is part of this review (D7 "UI provisional", D33). Builder choices (built): the
    old text-size setting moves to the stage size only; one row of section jumps that scrolls sideways; the mini
    faders have no meter or wheel indicator; ▤ Strips also in landscape; Edit chart… also in the sidebar. The default
    placement is the stage (orchestrator). (UI6-U7b O6, decision (a))
24. **Turning Chord charts off while the chart is on the stage** leaves the sidebar folded to its rail; turning them on
    again brings the chart back on the stage. Expect the sidebar back instead? (UI6-cship O4)
25. *(Fixed: auto-scroll carries on when the chart changes place, polish batch 1. See "Already answered".)*

## 3. Song bank and Try it (new layout)

26. **Try it builder choices** (built; tempo bands and Feel already answered by D26.4): Keep keeps what you changed
    while trying (so the kept song reads as edited and a newer pack version won't overwrite it); Back works under
    Lock; a second Try it keeps the first one's Back; My library's Try it is a plain switch (no banner); Next / Prev
    from a trial step from the replaced entry; if the replaced song is deleted during a trial, Back goes to the song
    after it; a setlist switch during a trial ends it. (UI6-U7a O5)
27. *(Fixed: the banner's words match what Keep does there, polish batch 1. See "Already answered".)*
28. **The Song bank browser's look** is provisional (O-AW-PP rule 8 "The picker UI is provisional"; D17 mockup).

## 4. MIDI Learn

29. **Can the mod wheel, CC7 / CC11 and pedals 66 / 67 be learned onto a level?** Today they can (touching the wheel
    while learning takes CC1). Option: skip CC1 / 11 in Learn on Perform. (UI6-U7c O2)
30. **Reassign or add?** Moving an already-learned knob onto Space makes it drive both (O-AW-ML rule 4); the toast says
    only "CC 21 → Grand Piano Space ✓". At least say "also moves …"? (UI6-U7c O3)
31. **Badges show the CC ("CC21")** instead of the mockup's "K1"; Arrange orders the sidebar from a list. Also: a tap on
    PANIC in learn mode panics and picks, so a PANIC footswitch is re-learned in Settings' table. (UI6-U7c O6)
32. **iPad entry gesture.** Safari sends no right-click / long-press menu, so today's Edit has no way to learn on the
    iPad; the new layout's Settings › MIDI Learn › Learn on Perform works. Needed before the iPad ships, or OK?
    (DECISIONS O-AW-ML rule 7, O1; UI6-U7c O5)
33. **D20 reading:** "revert with revert button, keep unchanged otherwise" was read as: a learned knob's move stays
    (changed dot) and Revert undoes it. Confirm. (DECISIONS D20)

## 5. Edit (new layout)

34. **Edit builder choices** (built): live moves (level, ON, drone level, master) never dot; a key change dots Drone ›
    Key & sound; Lock in Edit returns to Perform locked. (UI6-U5b builder choices; build plan "U5b status")
35. **(Only if item 51 allows portrait.) The strip is hidden in Edit at iPad portrait** (as in the mockup), so
    nothing in Edit can mute or set a level there, and the sentence's "off" word does nothing. (UI6-U5a O2)
36. **The Edit header at ≤ 1100 px is tight:** with Chart, Easy Transpose and an octave word at 1024 px the name shows
    "Sun…" and the key chip is cut (on touch the words go). Next step would be a two-row header or Chart in the ⋯
    menu there. (UI6-fu2 O2)
37. **The snapshot line now reserves its room** while a song has snapshots (so a footswitch doesn't move Edit's rig);
    that changes the header at rest. Check it looks right. (UI6-fu O2 → FU2)

## 6. Settings (new layout)

38. **Settings builder choices** (built): Esc in a drilled-in category (iPad portrait) closes Settings instead of going
    back to the list; search matches word starts only; Day / Stage / Auto shows for Daylight only (the mockup shows it
    for every theme); Perform view stays in Look; Learn… goes to today's table. (UI6-U6 O4)

## 7. iPad and small windows

51. **Portrait in the iPad app?** The app is landscape-only: Info-iPad allows landscape left / right and sets
    `UIRequiresFullScreen` (`native/apple/project.yml`), so the portrait layout U8a built shows only in emulation, and
    Split View / Stage Manager don't apply. Options: (a) landscape-only for 2.0 (as built); (b) add the portrait
    orientations (and drop `UIRequiresFullScreen` for Split View, which brings item 41 in). (project.yml; WEBKIT_AUDIT
    §7 B item 1 "Orientation decision"; D14 "iPad mirrors the Mac in landscape and portrait")
39. **iPad layout choices** (built; Start here under the song bar and the portrait top bar already answered by D26.5):
    Quick becomes an icon at ≤ 900 px; New song from the empty-library card plays it; Arrange on windows ≤ 790 px tall
    hides the Space / Echo / Octave / Sustain grid; 44 px sizing on touch only (the Mac keeps today's sizes); the
    Edit sentence's words are exempt from 44 px; with a MIDI problem at ≤ 900 px the ready words go. (UI6-U8a O5)
40. **iPad wording** still comes from today's screens: "No keyboard yet? Play A S D F G H J K on your computer (Space =
    sustain)" and "click "Restart sound"". Want iPad-specific words? (UI6-U8a O4)
41. **(Only if item 51 drops full screen.) Split View / Stage Manager windows narrower than tall** turn on the
    portrait layout (orientation queries). Seen only in emulation. (UI6-U8a O3)

## 8. Themes and colour

42. **Theme colour changes** (U8b, all pass the contrast audit): the day themes' instrument colours 4–6 are new
    (Sanctuary Day deep, Daylight Day pastels; dark themes' pos-4 `#ee84b2`); switches have a dark thumb when on; field
    borders are visibly stronger; popover and Quick shadows are much lighter, so dark-theme popovers read as flat
    sheets with a line (look at a dark theme with ⋯ open). (UI6-U8b O2)
43. **Bass a step lighter** for contrast costs Extra / Bass separation for colour-blind players (Nave 1.95 → 1.57,
    Studio 2.02 → 1.71, Daylight Day 1.60 → 1.33). The other option was a darker ON window with Bass unchanged.
    (UI6-U8b O3; DECISIONS D32 answers it only by adding the setting)
44. **Colour-blind palettes on dark themes are light pastels**, some near-white or neon (Classic rg `#fddbff` /
    `#fff37e`, the `#00fff8` cyans): may read as "selected" or glare. Options: (a) accept; (b) 6 colours + numbers;
    (c) cream / dark ink per lamp. Swatches: `native/docs/reviews/UI6-cvd-shots/palettes.svg`. (UI6-cvd O2)
45. **Sanctuary Day's colour-blind palettes are very deep** (`#001864`, `#420028` …), close to black as thin range bars.
    Same options. (UI6-cvd O3)
46. **Thin margins:** every colour-blind palette clears its distance by only 0.3–2.1 (a search optimum) and has only
    been simulated, not shown to colour-blind players. (UI6-cvd O4)
47. **Screen readers:** the instrument numbers are silent (accessible names as with colour-blind colours off). Want
    "Instrument 3, Strings" spoken? That goes in the names. (UI6-cvd O8)

## 9. Esc, PANIC and Lock

48. **"Esc always panics" on:** Esc panics with a pick, popover or sheet open, but not while typing in a box or with a
    modal dialog open (chart dialogs, Save snapshot). "Every Esc" = drop the dialog exception. (UI6-small O1;
    UI6-cship O5)

## 10. Design passes promised to Ryan (no build question yet)

49. **The setlist's look** (Cue, then Go): Ryan disliked the mockup UI around it; the look is provisional and gets a
    separate pass with him. (DECISIONS D6)
50. **The rest of the new layout** stays a proposal until seen on the Mac (D19), then U9 flips the default and retires
    today's screens (UI6-build-plan U9). Flipping it is tier 1: MAC_CHECK "2.0 release checklist" step 6.

## Already answered (not open; listed so they aren't asked again)

| item | answer | where |
|---|---|---|
| PANIC / Lock need a hold (UI6-U1 O1, O2) | PANIC a tap; Lock: tap locks, hold unlocks | D23.1, D26.3 |
| No v6 switch in the Mac app (UI6-U1 O3) | Settings › Look › Perform view › Try the new layout (preview) | lane-small |
| Snapshots under Lock (UI6-U1 O6) | Save / Update stay live | D24.1 |
| Range write on release (UI6-U2 O1) | live, throttled | D24.2 |
| Esc in range pick (UI6-U2 O2) | Esc finishes the pick; setting "Esc always panics" | D24.7 |
| Tap first on mouse too (UI6-U2 O3) | yes, every pointer | D24.3 |
| 1024 px with the sidebar (UI6-U3 O1, UI6-U4 O1) | folded at ≤ 1100 px until opened; slim Add from 4 | build plan "Small-window fit" |
| New song selected? / Notes-Setlist only open (UI6-U3 O7 part) | not selected; only open | D24.4, D24.5 |
| Drone Bright / Move % | shown | D24.6 |
| Edit category dots (UI6-U5a O1) | every category dots "changed since the song began" | U5b |
| Edit range bars draggable (UI6-U5b O1) | yes, with Perform's guards | D26.2, U-EDITRANGE |
| What a snapshot holds (D25, UI6-U7c open) | also Space / Echo / drone; key follows the song, optional relative key | D26.1, D26.1a |
| Song bank tempo bands, Feel (UI6-U7a O5 part) | < 80 / 80–114 / ≥ 115; any chosen tag | D26.4 |
| Start here card, portrait top bar (UI6-U8a O5 part) | as built | D26.5 |
| Chart default placement (UI6-U7b) | the stage | orchestrator decision (a) |
| Empty library keeps a sound (UI6-er O1) | goes silent; PANIC stops an orphaned drone | build plan "Empty-library silence" |
| Master stays faded after the empty spell (UI6-fu O1) | fade only while something is held (option b) | FU2 |
| Edit doesn't say it edits the snapshot (UI6-snap O1) | a line under Edit's header | U-SNAP follow-up |
| Rotation / "n min ago" in Settings (UI6-U6 O1, O2) | fixed | U8a |
| Daylight Day Sound note contrast (UI6-U6 O3) | fixed | U8b |
| Keyboard reach of handles, small-window latch (UI6-move O2, O3) | fixed | U8a |
| Range-bar numbers stacking, dot over the number, muted number (UI6-cvd O1, O5, O6) | fixed | CVD2 |
| Size rules for add / duplicate (D33 O4) | warn past 2 MB, refuse past 2.5 MB; chart / bank / pack top-up to follow (CAP, in flight) | D9, D33 note |
| Chart in 2.0 | yes, on by default | D33 |
| Desktop Auto voice limit (item 6) | stays 128; 256 / 512 stay manual choices | D5 follow-up (Ryan, 2026-11-21) |
| PDF charts / notation in 2.0 (item 8) | after 2.0 | D33 |
| Chart auto-scroll stops on a place change (item 25, UI6-U7b O2) | it carries on | polish batch 1 (UI6-polish1) |
| Keep on an in-library trial song (item 27, UI6-U7b O3) | the words match what Keep does | polish batch 1 (UI6-polish1) |
| Colour-blind setting | Settings › Look › Colour-blind colours | D32 |
