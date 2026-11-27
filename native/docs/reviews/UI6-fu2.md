# FU2 (UI6-fu O1–O3 + layout quirks) + CVD2 (UI6-cvd O1/O5/O6): skeptic review (2026-11-27)

Verdict: **VERIFIED after F1 and F2.** Two defects, both fixed on lane-fu2 with a test that fails before the fix:
the v6 Edit key chip hid the key you play at every width up to 1100 px (F1), and today's keyboard drew a muted
instrument's number at 3.6 : 1 in Daylight Stage (F2). Everything else does what CONTRACT_CHANGES "## FU2" and
"## CVD2" say. The bank-trial flake is a test-only problem: Chromium, where the app runs, does not fail the way Node
fetch does (measured). One open item is for Ryan: the v6 keyboard's muted bar keeps its lamp colour (O1).

Under review: the builder's 11 commits (tip 953cd10), rebased onto origin/v2-native cae9f84 (C-SHIP). Conflicts:
- `app/styles-v6-edit.css`: C-SHIP and FU2 both hid the v6 Edit "Time" caption at ≤ 1100 px. Kept one media query:
  C-SHIP's `display: none` caption, 6 px gaps and chart padding, plus FU2's key-chip rules. FU2's visually-hidden
  caption rule was a duplicate and is gone (the select keeps aria-label "Time signature" either way).
- `CONTRACT_CHANGES.md` (both sections kept; the FU2 line now says the caption is C-SHIP's) and
  `native/docs/lanes/UI6-build-plan.md` (CAP queued + CVD2 Built, both kept).
- Test registrations merged cleanly: C-SHIP's tests and FU2's `snapres` / `layout-fu2` / `cvd2` each appear once.

`app/js/engine/` is untouched (`git diff origin/v2-native --stat -- app/js/engine` is empty). Probe scripts are in
`/home/claude/scratch/fu2-sk/` and their outputs in the worktree's `.probe/` (not committed).

## 1. Empty library: fade only when something is held

Measured in the real web engine (Chromium, flag off and `?ui6=1`), song drone ON, every song deleted, then Settings'
Restore previous library, then Next:

| held at the delete | empty: drone / faded / fadeGain | restored | after Next |
|---|---|---|---|
| nothing | off / false / 1 | synth, sounding, not faded | same |
| a key played and released | off / false / 1 | synth, sounding, not faded | same |
| a key held (released before the restore) | off / **true** / 0.37 (chip on) | synth, sounding, **faded** | **faded** |

- The drone goes off once per empty spell. UI6-fu F1 still holds: the restored library plays its drone.
- With nothing held, the next song never starts faded.
- With a key held at the delete, the master stays faded through the restore and Next until a note. That is option
  (b)'s known residue (UI6-fu O1), not a defect.
- Every note and pedal goes through `noteOnFrom` / `pedalBySrc`, so `heldCount` / `pedalDown` cover the on-screen
  keys, the computer keys, MIDI keys and the MIDI CC64 pedal. The shell tests cover key, pedal, MIDI key and nothing
  held. The MIDI CC64 path sets the same `pedalDown` and was read, not run.

## 2. Snapshot line: reserved height

- **0 px shift.** The rig's top stays at the same pixel over three footswitch steps (`controller.scenes.next`: the
  same `stepSceneBy` as a learned footswitch) at 1280×800, 1024×700 and 820×1180 touch, in both Edits (probe-a2).
  The builder's `snapres` test also covers every element of `#view-edit`.
- **No snapshots, no change.** The Edit layout's rect hash matches the base at every size. The only differences are
  the intended ones: today's Edit is 820 wide at 820, and the v6 ≤ 1100 px header rules (bare-headers.txt).
- **One line.** The line is 19 px with a mouse and 46 px on touch, and it never overflows the header. The store caps
  snapshot names at 40 characters, so no real name needs the ellipsis at 820 px. The CSS for it is there.
- **The text follows the steps.** It reads 1 → 2 → 3 → 1, go(2), prev, go(0) correctly, the same as the base
  (snapline-step.txt).
- **role=status is quiet while idle.** The idle line (`visibility: hidden`) is not in the accessibility tree (CDP
  `Accessibility.getFullAXTree`), and renaming snapshots while idle adds nothing. While a snapshot plays it is one
  `status` node, live=polite. A snapshot starting rewrites the line (`idle:` signature), so it is announced once.

## 3. bank-trial flake: root cause and the app's boot

- The builder's root cause holds for Node. A Node `fetch` against a server in the same process, with the loop blocked
  for 6.5 s past `keepAliveTimeout` 5 s, failed **3/6** (ka-probe3.txt).
- **Chromium, under the same server block, failed 0/6.** A short-timeout race in both clients: 0/200 each.
- So the fix belongs in the test file only. The app runs in Chromium: Electron, or Chrome against `npm run serve`.
  The server runs in another process (Electron's main, or the serve process), and the server is listening before the
  window loads.
- If `/api/user-patches` ever did fail once, the bank stays empty until Settings › My Samples › Rescan. The v6 bank
  browser only reads `patchPacks()`. No realistic transient was found, so no O-item.

## 4. Layout

- **v6 Edit ≤ 1100 px with the Chart button.** Swept at 15 widths from 1024 to 1280, mouse and touch, short and long
  song names: ⋯ Song always inside the header (2 px spare), no sideways scroll (probe-layout.json). Then **F1**.
- **Today's Edit below 1024 px.** `body` min-width is 0 only while today's Edit is the visible view. Perform at 820
  keeps 1024 px, and so does Edit at ≥ 1024. With Settings open over Edit it stays 0, which is right: Edit is under
  it.
- Flag-off purity: the ui-v6 and ui-v6-edit gates (below).

## 5. CVD2

- **placeBadges never overlaps numbers:**
  - in a pure fuzz of 15 048 cases (W 400–1240 px, 2–16 bars, identical / one octave / clipped left, right, both /
    past the keys / random), 0 overlaps and 0 outside the keyboard. The 16 badges need 298 px in all;
  - in the real DOM, 36 layouts (16 instruments: identical whole keyboard, identical short, one octave, clipped low,
    high, both; v6 and today's keyboard; 1280 / 1024 / 820), 0 overlaps and 0 outside.

  Where there is no room, badges sit off their own bar (the builder's stated risk), never on another badge.
- **Off writes nothing.** No `--cvd-x`. A class change with cvd Off schedules no keys.js frame. Turning it Off
  schedules exactly one frame, which removes what On wrote.
- **No leaks.** keys.js MutationObservers live: 1, and ResizeObservers live: ≤ 1 (0 after Off). This holds after
  4 view flips, 3 flag flips each way (cvd Off and On) and song changes, flag off and on. keys.js frames per cvd
  flip stay 2 on / 1 off throughout (probe-mo.json, probe-cvd.json). With cvd Off, the flag-off page keeps one
  html-class observer (builder's note; purity doesn't count observers).
- **Edit tab dot vs a two-digit number.** 16 changed tabs at 820×1180 (iPad portrait, 150 px tabs): no dot over a
  number. The builder's test covers 1280 / 1024.
- **Muted numbers.** v6: 6.36–10.93 : 1 in all 8 themes. Today's: **F2**.
- **The v6 muted bar keeps its lamp colour.** Confirmed: `.v6 .v6-kbd .v6-rbar { background: var(--c) }` out-ranks
  `.rbar.off`, contrary to styles-v6-keyboard.css line 4. With cvd Off, in Sanctuary, instrument 2 (muted) has a
  green bar, rgb(78,196,145), where today's keyboard draws grey, rgb(91,75,86). That is O1, left unchanged.

## Findings

- **F1 (fixed, b3f9495): the v6 Edit key chip hid the key you play at every width up to 1100 px.**
  - FU2's give-way set the chip to `flex-shrink: .1` against the name's 1, so the chip always shrank in proportion.
    At 1100 px with a mouse the name was still 151 px wide while "· you play C" lost its last 4 px. The ellipsis
    covered the "C", the one word the player needs. At 1024 touch the cut was 16 px.
  - The builder's "the song name gives way first, to its 6ch" was not what the CSS did.
  - Fix (≤ 1100 px, v6 only):
    - the name takes the squeeze until its 6ch (`flex-shrink: 1000`);
    - the chip's text is two spans, `.ev2-song-playw` "· you play " and `.ev2-song-playk` (the key and octave word);
    - the words give way first, and the key goes only as a last resort (1024 touch with the Chart button and an
      octave word, "F#m −1 oct").
  - Today's Edit keeps one text node (flag-off DOM unchanged), and the textContent is the same.
  - Measured after the fix: the key is whole in every case but that last resort. While the name is above its 6ch
    the chip is never cut. The trade: at ≤ 1100 px a long song name now ellipsizes sooner, down to "Sun…".
  - Above 1100 px nothing moves. At 1280 the v6 header differs from the base only by sub-pixel antialiasing right of
    the chip (two text runs instead of one; no visible change), and 1180 is pixel-identical.
  - Test: ui-v6-edit "FU2 skeptic F1" (1024 / 1040 / 1064 / 1100, mouse / touch, chart on / off, keys C and F#m −1
    oct). It fails before the fix ("1024 chart on: the played key is cut") and passes after.
- **F2 (fixed, 51b8804): today's muted range-bar number was 3.60 : 1 in Daylight Stage.**
  - The builder measured Sanctuary only. Today's rule drew the bar's grey, rgb(135,122,107), under `--text`,
    rgb(245,237,224).
  - Fix: both keyboards use the v6 rule (`--muted` with `--bg` on it), ≥ 4.5 : 1 in all 8 themes. It applies only
    with colour-blind colours on, so cvd-Off pixels are unchanged.
  - Test: ui-v6 "CVD2 O1: today's keyboard" now checks the muted number in all 8 themes (grey, not the lamp colour,
    ≥ 4.5 : 1). It fails before the fix and passes after.

## Gates

`tools/cloud/gates.mjs`, tree 2dc3788 (every code change; only this doc's gates / items text and LANE.md changed
after), PLAYWRIGHT_BROWSERS_PATH=/root/.cache/rig-pw, UI6_PURITY_BASE=origin/v2-native, one suite at a time.

| suite | result |
|---|---|
| shell-unit | PASS 419/419 |
| unit | PASS 694 pass, 0 fail, 12 skip |
| chart | PASS 47/47 on rerun. First run (load avg ≈ 12, another agent's suites beside it): 45/47, a v6 purity boot's `__rig.ready` past 40 s and "U7b contrast" reading `.v6-ts-n` at 1.34 : 1 in Sanctuary Day (mid theme switch). Nothing of the chart changed; it passed on the rebased tree before my fixes too (169 s) |
| ui-v6 | PASS 95/95 on rerun (423 s of its 480 s budget), flag-off purity vs origin/v2-native identical. First run: TIMEOUT at 480 s under load ≈ 12, with 94 passed when it was killed (in "screenshots"). See O3 |
| ui-v6-edit | PASS 49/49, flag-off purity identical (Edit too) |
| ui-v6-ipad | PASS 29/29 |
| ui-v6-bank | PASS 23/23 |
| settings | PASS 118/118 (app, fixture, mac, bridge, v6) |
| ui-core | PASS 96/96 |
| edit-v2 | PASS 117 pass, 0 fail |
| ui-v6-themes | PASS 30/30 themes clean (text 0, rings 0, bounds 0, errors 0, missed 0), 2067 s |

0 console.error and 0 HTTP ≥ 400: every browser suite's own check, plus my probes. `app/js/engine/` is untouched.

## Open items

- **O1 (Ryan): in the v6 keyboard a muted instrument's range bar keeps its lamp colour.** In today's keyboard it
  goes grey.
  - Cause: `.v6 .v6-kbd .v6-rbar { background: var(--c) }` out-ranks every theme's `.rbar.off`. Only the handles go
    grey. styles-v6-keyboard.css's header comment says the opposite.
  - The strip says "muted" (struck-through level, greyed controls), and with colour-blind colours on the number now
    goes grey. The bar, though, still reads as "playing".
  - Screenshots: `UI6-fu2-shots/v6-muted-cvd-off-sanctuary.png` (instrument 2 muted, green bar) and
    `today-muted-cvd-off-sanctuary.png` (grey bar).
  - Fixing it (`.v6 .v6-kbd .v6-rbar.off { background: <the theme's off grey> }`) changes v6 pixels with cvd Off.
    Not touched.
- **O2 (Ryan, low): the v6 Edit header ≤ 1100 px is tight.** With the Chart button on, Easy Transpose on and an
  octave word, a 1024 px window shows the song name as "Sun…" and the chip as "· you pla… F#m −1 oct". On touch at
  1024 the words are gone and the key is cut too. C-SHIP and FU2 together have used up the give-ways that cost
  nothing. A two-row header at ≤ 1100 px, or Chart in the ⋯ Song menu there, would be the next step.

- **O3 (orchestrator): the ui-v6 suite runs close to its budget.** 423 s of 480 s on a quiet box (the builder's run:
  333 s). It timed out at load average ≈ 12. CVD2's tests and F2's 8-theme loop add about 45 s. Raise the budget to
  10 min in `test/run-all.mjs`, as FU2 did for ui-v6-edit. I did not change it, because that would have invalidated
  the gate run above.

## Not verified

- A real iPad, the Mac app (Electron/WebKit), real fingers and a MIDI footswitch. Snapshot steps used
  `controller.scenes.next` (the footswitch's `stepSceneBy`), and touch was Playwright `hasTouch`.
- Screen-reader speech. I checked only the accessibility tree: the idle line is absent, and one status node is
  present while a snapshot plays.
- The MIDI CC64 pedal path into the empty-library fade (read: it sets the same `pedalDown`).
- The Electron / Mac suites, migration-1x and phase-2 themes.
- How the fade or drone sounds: the state was read from the web engine (`fadeGain`, `drone.cfg`, `sounding`).

## Lane tip

lane-fu2 at the commit that adds this report (after 2dc3788, where every gate passed; this doc and LANE.md only).
Not pushed, not merged.
